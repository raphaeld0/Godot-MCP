extends SceneTree

const RESULT_PREFIX := "GODOT_MCP_RESULT:"
const MAX_PROJECT_FILES := 10000
const RESOURCE_EXTENSIONS := ["tscn", "tres", "res", "scn"]


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var request_path := ""
	for index in range(args.size() - 1):
		if args[index] == "--request":
			request_path = args[index + 1]
			break

	if request_path.is_empty():
		_finish({"success": false, "error": "Missing --request argument."})
		return

	var request_file := FileAccess.open(request_path, FileAccess.READ)
	if request_file == null:
		_finish({"success": false, "error": "Could not read the operation request."})
		return

	var request: Variant = JSON.parse_string(request_file.get_as_text())
	request_file.close()
	if not request is Dictionary:
		_finish({"success": false, "error": "Operation request must be a JSON object."})
		return

	var result: Dictionary = _dispatch(request)
	_finish(result)


func _finish(result: Dictionary) -> void:
	print(RESULT_PREFIX + JSON.stringify(result))
	quit(0 if result.get("success", false) else 1)


func _dispatch(request: Dictionary) -> Dictionary:
	match String(request.get("operation", "")):
		"get_project_info":
			return _get_project_info(request)
		"create_scene":
			return _create_scene(request)
		"add_node":
			return _add_node(request)
		"load_sprite":
			return _load_sprite(request)
		"save_scene":
			return _save_scene(request)
		"export_mesh_library":
			return _export_mesh_library(request)
		"get_uid":
			return _get_uid(request)
		"update_project_uids":
			return _update_project_uids(request)
		_:
			return {"success": false, "error": "Unsupported Godot operation."}


func _get_project_info(_request: Dictionary) -> Dictionary:
	var settings := {}
	var sections: Array[String] = []
	var config := FileAccess.open("res://project.godot", FileAccess.READ)
	if config == null:
		return {"success": false, "error": "Could not read project.godot."}

	for line in config.get_as_text().split("\n"):
		var trimmed := line.strip_edges()
		if trimmed.begins_with("[") and trimmed.ends_with("]"):
			sections.clear()
			sections.append(trimmed.trim_prefix("[").trim_suffix("]"))
		elif not trimmed.is_empty() and not trimmed.begins_with(";"):
			var separator := trimmed.find("=")
			if separator > 0:
				var key := trimmed.substr(0, separator).strip_edges()
				var value := trimmed.substr(separator + 1).strip_edges()
				settings["/".join(PackedStringArray(sections + [key]))] = value
	config.close()

	var max_depth := int(_request.get("max_depth", 6))
	var max_files := int(_request.get("max_files", 2000))
	var files: Array[String] = []
	var overflow := [false]
	_collect_files("res://", "", 0, max_depth, max_files, files, overflow)
	if overflow[0]:
		return {
			"success": false,
			"error": "Project contains more than %d files. Increase maxFiles or inspect a smaller project." % max_files,
		}

	return {
		"success": true,
		"data": {
			"settings": settings,
			"files": files,
			"file_count": files.size(),
		},
	}


func _collect_files(
	root: String,
	relative_path: String,
	depth: int,
	max_depth: int,
	max_files: int,
	files: Array[String],
	overflow: Array
) -> void:
	if overflow[0] or depth > max_depth:
		return
	var directory := DirAccess.open(root.path_join(relative_path))
	if directory == null:
		return
	directory.list_dir_begin()
	var entry := directory.get_next()
	while not entry.is_empty():
		if entry != "." and entry != ".." and not entry.begins_with("."):
			var child_path := entry if relative_path.is_empty() else relative_path.path_join(entry)
			if directory.current_is_dir():
				if not entry in [".git", ".godot", "node_modules"]:
					_collect_files(root, child_path, depth + 1, max_depth, max_files, files, overflow)
			else:
				files.append("res://" + child_path)
				if files.size() > max_files:
					overflow[0] = true
					break
		entry = directory.get_next()
	directory.list_dir_end()


func _valid_resource_path(path: String, allowed_extensions: Array = []) -> bool:
	if not path.begins_with("res://") or path.contains("\\"):
		return false
	var relative := path.trim_prefix("res://")
	if relative.is_empty():
		return false
	for segment in relative.split("/"):
		if segment.is_empty() or segment == "." or segment == "..":
			return false
	if not allowed_extensions.is_empty():
		var extension := path.get_extension().to_lower()
		if not extension in allowed_extensions:
			return false
	return true


func _ensure_parent_directory(resource_path: String) -> Error:
	var directory_path := resource_path.get_base_dir()
	if directory_path == "res://":
		return OK
	return DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(directory_path))


func _save_packed_scene(root: Node, scene_path: String, overwrite: bool) -> Dictionary:
	if not _valid_resource_path(scene_path, ["tscn"]):
		return {"success": false, "error": "Scene paths must be project-relative res:// paths ending in .tscn."}
	if FileAccess.file_exists(scene_path) and not overwrite:
		return {"success": false, "error": "Scene already exists. Set overwrite=true to replace it."}
	var directory_error := _ensure_parent_directory(scene_path)
	if directory_error != OK:
		return {"success": false, "error": "Could not create the scene directory: %s" % error_string(directory_error)}
	var packed_scene := PackedScene.new()
	var pack_error := packed_scene.pack(root)
	if pack_error != OK:
		return {"success": false, "error": "Could not pack scene: %s" % error_string(pack_error)}
	var save_error := ResourceSaver.save(packed_scene, scene_path)
	if save_error != OK:
		return {"success": false, "error": "Could not save scene: %s" % error_string(save_error)}
	return {"success": true, "data": {"scene_path": scene_path}}


func _new_node(node_class: String) -> Node:
	if not ClassDB.class_exists(node_class) or not ClassDB.is_parent_class(node_class, "Node"):
		return null
	return ClassDB.instantiate(node_class) as Node


func _valid_node_name(node_name: String) -> bool:
	return (
		not node_name.is_empty()
		and node_name != "."
		and node_name != ".."
		and not node_name.contains("/")
		and not node_name.contains(":")
	)


func _create_scene(request: Dictionary) -> Dictionary:
	var scene_path := String(request.get("scene_path", ""))
	var root_type := String(request.get("root_type", "Node2D"))
	var root_name := String(request.get("root_name", "Root"))
	if not _valid_node_name(root_name):
		return {"success": false, "error": "Root name must be a single valid node name."}
	var root := _new_node(root_type)
	if root == null:
		return {"success": false, "error": "Root type must be a built-in Godot Node class."}
	root.name = root_name
	var result := _save_packed_scene(root, scene_path, bool(request.get("overwrite", false)))
	root.free()
	return result


func _decode_property_value(value: Variant) -> Variant:
	if not value is Dictionary or not value.has("$type"):
		return value
	match String(value["$type"]):
		"StringName":
			return StringName(String(value.get("value", "")))
		"Vector2":
			return Vector2(float(value.get("x", 0)), float(value.get("y", 0)))
		"Vector2i":
			return Vector2i(int(value.get("x", 0)), int(value.get("y", 0)))
		"Vector3":
			return Vector3(float(value.get("x", 0)), float(value.get("y", 0)), float(value.get("z", 0)))
		"Vector3i":
			return Vector3i(int(value.get("x", 0)), int(value.get("y", 0)), int(value.get("z", 0)))
		"Color":
			return Color(
				float(value.get("r", 0)),
				float(value.get("g", 0)),
				float(value.get("b", 0)),
				float(value.get("a", 1))
			)
		"Rect2":
			return Rect2(
				Vector2(float(value.get("x", 0)), float(value.get("y", 0))),
				Vector2(float(value.get("width", 0)), float(value.get("height", 0)))
			)
		"Rect2i":
			return Rect2i(
				Vector2i(int(value.get("x", 0)), int(value.get("y", 0))),
				Vector2i(int(value.get("width", 0)), int(value.get("height", 0)))
			)
		"Quaternion":
			return Quaternion(
				float(value.get("x", 0)),
				float(value.get("y", 0)),
				float(value.get("z", 0)),
				float(value.get("w", 1))
			)
		"Basis":
			return Basis(
				_decode_property_value(value.get("x", {"$type": "Vector3"})),
				_decode_property_value(value.get("y", {"$type": "Vector3"})),
				_decode_property_value(value.get("z", {"$type": "Vector3"}))
			)
		"Transform2D":
			return Transform2D(
				_decode_property_value(value.get("x", {"$type": "Vector2"})),
				_decode_property_value(value.get("y", {"$type": "Vector2"})),
				_decode_property_value(value.get("origin", {"$type": "Vector2"}))
			)
		"Transform3D":
			return Transform3D(
				_decode_property_value(value.get("basis", {"$type": "Basis"})),
				_decode_property_value(value.get("origin", {"$type": "Vector3"}))
			)
		"AABB":
			return AABB(
				_decode_property_value(value.get("position", {"$type": "Vector3"})),
				_decode_property_value(value.get("size", {"$type": "Vector3"}))
			)
		"Plane":
			return Plane(
				_decode_property_value(value.get("normal", {"$type": "Vector3"})),
				float(value.get("d", 0))
			)
		"NodePath":
			return NodePath(String(value.get("path", "")))
		"PackedByteArray":
			return PackedByteArray(value.get("values", []))
		"PackedInt32Array":
			return PackedInt32Array(value.get("values", []))
		"PackedInt64Array":
			return PackedInt64Array(value.get("values", []))
		"PackedFloat32Array":
			return PackedFloat32Array(value.get("values", []))
		"PackedFloat64Array":
			return PackedFloat64Array(value.get("values", []))
		"PackedStringArray":
			return PackedStringArray(value.get("values", []))
		"PackedVector2Array":
			var vectors_2: Array[Vector2] = []
			for item in value.get("values", []):
				vectors_2.append(_decode_property_value(item))
			return PackedVector2Array(vectors_2)
		"PackedVector3Array":
			var vectors_3: Array[Vector3] = []
			for item in value.get("values", []):
				vectors_3.append(_decode_property_value(item))
			return PackedVector3Array(vectors_3)
		"PackedColorArray":
			var colors: Array[Color] = []
			for item in value.get("values", []):
				colors.append(_decode_property_value(item))
			return PackedColorArray(colors)
		"Resource":
			var resource_path := String(value.get("path", ""))
			if _valid_resource_path(resource_path):
				return ResourceLoader.load(resource_path)
			return null
	return value


func _apply_properties(node: Node, properties: Dictionary) -> String:
	var property_descriptors := {}
	for property in node.get_property_list():
		property_descriptors[property["name"]] = property
	for key in properties:
		if not property_descriptors.has(key):
			return "Node type %s has no property named %s." % [node.get_class(), key]
		var value: Variant = _decode_property_value(properties[key])
		if value == null and properties[key] is Dictionary and properties[key].get("$type") == "Resource":
			return "Could not load resource for property %s." % key
		var expected_type := int(property_descriptors[key]["type"])
		var actual_type := typeof(value)
		var is_numeric_conversion := (
			expected_type == TYPE_FLOAT and actual_type == TYPE_INT
			or expected_type == TYPE_INT and actual_type == TYPE_FLOAT and is_equal_approx(value, round(value))
		)
		if actual_type != expected_type and not is_numeric_conversion:
			return "Property %s expects %s but received %s." % [
				key,
				type_string(expected_type),
				type_string(actual_type),
			]
		if expected_type == TYPE_OBJECT and value != null:
			var expected_class := String(property_descriptors[key].get("class_name", ""))
			if not expected_class.is_empty() and not value.is_class(expected_class):
				return "Property %s expects a %s resource." % [key, expected_class]
		node.set(key, value)
		if node.get(key) != value:
			return "Godot rejected the value supplied for property %s." % key
	return ""


func _load_scene_instance(scene_path: String) -> Node:
	if not _valid_resource_path(scene_path, ["tscn"]):
		return null
	var packed_scene := ResourceLoader.load(scene_path) as PackedScene
	if packed_scene == null:
		return null
	return packed_scene.instantiate()


func _add_node_to_scene(root: Node, parent_path: String, node: Node) -> String:
	var parent := root if parent_path.is_empty() or parent_path == "." else root.get_node_or_null(NodePath(parent_path))
	if parent == null:
		return "Parent node not found: %s" % parent_path
	if parent.get_node_or_null(NodePath(String(node.name))) != null:
		return "A child named %s already exists under %s." % [node.name, parent_path]
	parent.add_child(node)
	node.owner = root
	return ""


func _add_node(request: Dictionary) -> Dictionary:
	var scene_path := String(request.get("scene_path", ""))
	var root := _load_scene_instance(scene_path)
	if root == null:
		return {"success": false, "error": "Could not load the source scene."}
	var node := _new_node(String(request.get("node_type", "Node")))
	if node == null:
		root.free()
		return {"success": false, "error": "Node type must be a built-in Godot Node class."}
	node.name = String(request.get("node_name", node.get_class()))
	if not _valid_node_name(String(node.name)):
		root.free()
		node.free()
		return {"success": false, "error": "Node name must be a single valid node name."}
	var property_error := _apply_properties(node, request.get("properties", {}))
	if not property_error.is_empty():
		root.free()
		node.free()
		return {"success": false, "error": property_error}
	var parent_path := String(request.get("parent_path", "."))
	var add_error := _add_node_to_scene(root, parent_path, node)
	if not add_error.is_empty():
		root.free()
		node.free()
		return {"success": false, "error": add_error}
	var result := _save_packed_scene(root, scene_path, true)
	root.free()
	return result


func _load_sprite(request: Dictionary) -> Dictionary:
	var scene_path := String(request.get("scene_path", ""))
	var texture_path := String(request.get("texture_path", ""))
	if not _valid_resource_path(texture_path):
		return {"success": false, "error": "Texture path must be a project-relative res:// path."}
	var texture := ResourceLoader.load(texture_path) as Texture2D
	if texture == null:
		return {"success": false, "error": "Could not load a Texture2D from %s." % texture_path}
	var root := _load_scene_instance(scene_path)
	if root == null:
		return {"success": false, "error": "Could not load the source scene."}
	var sprite := Sprite2D.new()
	sprite.name = String(request.get("node_name", "Sprite2D"))
	if not _valid_node_name(String(sprite.name)):
		root.free()
		sprite.free()
		return {"success": false, "error": "Sprite node name must be a single valid node name."}
	sprite.texture = texture
	var add_error := _add_node_to_scene(root, String(request.get("parent_path", ".")), sprite)
	if not add_error.is_empty():
		root.free()
		sprite.free()
		return {"success": false, "error": add_error}
	var result := _save_packed_scene(root, scene_path, true)
	root.free()
	return result


func _save_scene(request: Dictionary) -> Dictionary:
	var source_path := String(request.get("scene_path", ""))
	var output_path := String(request.get("output_path", source_path))
	var overwrite := bool(request.get("overwrite", false)) or output_path == source_path
	var root := _load_scene_instance(source_path)
	if root == null:
		return {"success": false, "error": "Could not load the source scene."}
	var result := _save_packed_scene(root, output_path, overwrite)
	root.free()
	if result.get("success", false):
		result["data"]["source_path"] = source_path
	return result


func _export_mesh_library(request: Dictionary) -> Dictionary:
	var scene_path := String(request.get("scene_path", ""))
	var output_path := String(request.get("output_path", ""))
	if not _valid_resource_path(output_path, ["tres", "res"]):
		return {"success": false, "error": "MeshLibrary output must be a project-relative .tres or .res path."}
	if FileAccess.file_exists(output_path) and not bool(request.get("overwrite", false)):
		return {"success": false, "error": "MeshLibrary output exists. Set overwrite=true to replace it."}
	var root := _load_scene_instance(scene_path)
	if root == null:
		return {"success": false, "error": "Could not load the source scene."}
	var mesh_nodes: Array[MeshInstance3D] = []
	_collect_mesh_nodes(root, mesh_nodes)
	if mesh_nodes.is_empty():
		root.free()
		return {"success": false, "error": "Source scene contains no MeshInstance3D nodes with meshes."}

	var library := MeshLibrary.new()
	var item_names: Array[String] = []
	for item_id in range(mesh_nodes.size()):
		var mesh_node := mesh_nodes[item_id]
		library.create_item(item_id)
		library.set_item_name(item_id, String(mesh_node.name))
		library.set_item_mesh(item_id, mesh_node.mesh)
		library.set_item_mesh_transform(item_id, mesh_node.global_transform)
		var collision_shapes: Array = []
		var static_body := _find_static_body(mesh_node, root)
		if static_body != null:
			_collect_collision_shapes(static_body, root, static_body, collision_shapes)
		if not collision_shapes.is_empty():
			library.set_item_shapes(item_id, collision_shapes)
		item_names.append(String(mesh_node.name))

	var directory_error := _ensure_parent_directory(output_path)
	if directory_error != OK:
		root.free()
		return {"success": false, "error": "Could not create the output directory: %s" % error_string(directory_error)}
	var save_error := ResourceSaver.save(library, output_path)
	root.free()
	if save_error != OK:
		return {"success": false, "error": "Could not save MeshLibrary: %s" % error_string(save_error)}
	return {
		"success": true,
		"data": {"output_path": output_path, "item_count": item_names.size(), "items": item_names},
	}


func _collect_mesh_nodes(node: Node, result: Array[MeshInstance3D]) -> void:
	if node is MeshInstance3D and node.mesh != null:
		result.append(node)
	for child in node.get_children():
		_collect_mesh_nodes(child, result)


func _find_static_body(mesh_node: Node, root: Node) -> StaticBody3D:
	var ancestor := mesh_node as Node
	while ancestor != null:
		if ancestor is StaticBody3D:
			return ancestor
		if ancestor == root:
			break
		ancestor = ancestor.get_parent()
	return null


func _collect_collision_shapes(
	node: Node,
	root: Node,
	body: StaticBody3D,
	result: Array
) -> void:
	if node is StaticBody3D and node != body:
		return
	if node is CollisionShape3D and node.shape != null:
		result.append(node.shape)
		result.append(root.global_transform.affine_inverse() * node.global_transform)
	for child in node.get_children():
		_collect_collision_shapes(child, root, body, result)


func _get_uid(request: Dictionary) -> Dictionary:
	var resource_path := String(request.get("resource_path", ""))
	if not _valid_resource_path(resource_path):
		return {"success": false, "error": "Resource path must be a project-relative res:// path."}
	if not FileAccess.file_exists(resource_path):
		return {"success": false, "error": "Resource file does not exist: %s" % resource_path}
	var uid := ResourceLoader.get_resource_uid(resource_path)
	if uid == ResourceUID.INVALID_ID:
		return {"success": true, "data": {"resource_path": resource_path, "uid": null}}
	return {
		"success": true,
		"data": {"resource_path": resource_path, "uid": ResourceUID.id_to_text(uid)},
	}


func _update_project_uids(request: Dictionary) -> Dictionary:
	var apply_changes := bool(request.get("apply", false))
	var resource_paths: Array[String] = []
	var overflow := [false]
	_collect_resave_candidates("res://", "", resource_paths, overflow)
	if overflow[0]:
		return {"success": false, "error": "Project has more than %d resavable resources." % MAX_PROJECT_FILES}
	if not apply_changes:
		return {
			"success": true,
			"data": {
				"dry_run": true,
				"candidate_count": resource_paths.size(),
				"candidates": resource_paths,
				"message": "No project resources were resaved. Call again with apply=true to resave these scene and resource files.",
			},
		}

	var updated: Array[String] = []
	var failures: Array[String] = []
	for resource_path in resource_paths:
		var resource := ResourceLoader.load(resource_path, "", ResourceLoader.CACHE_MODE_IGNORE)
		if resource == null:
			failures.append("%s: could not load resource" % resource_path)
			continue
		var save_error := ResourceSaver.save(resource, resource_path)
		if save_error != OK:
			failures.append("%s: %s" % [resource_path, error_string(save_error)])
		else:
			updated.append(resource_path)

	return {
		"success": failures.is_empty(),
		"data": {
			"dry_run": false,
			"updated_count": updated.size(),
			"updated": updated,
			"failures": failures,
		},
		"error": "Some resources could not be resaved: %s" % "; ".join(failures) if not failures.is_empty() else "",
	}


func _collect_resave_candidates(
	root: String,
	relative_path: String,
	result: Array[String],
	overflow: Array
) -> void:
	if overflow[0]:
		return
	var directory := DirAccess.open(root.path_join(relative_path))
	if directory == null:
		return
	directory.list_dir_begin()
	var entry := directory.get_next()
	while not entry.is_empty():
		if entry != "." and entry != ".." and not entry.begins_with("."):
			var child_path := entry if relative_path.is_empty() else relative_path.path_join(entry)
			if directory.current_is_dir():
				if not entry in [".git", ".godot", "node_modules"]:
					_collect_resave_candidates(root, child_path, result, overflow)
			elif entry.get_extension().to_lower() in RESOURCE_EXTENSIONS:
				result.append("res://" + child_path)
				if result.size() > MAX_PROJECT_FILES:
					overflow[0] = true
					break
		entry = directory.get_next()
	directory.list_dir_end()
