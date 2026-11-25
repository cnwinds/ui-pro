extends SceneTree
## Builds or updates one screen scene from a UI-Pro export spec.
## godot --headless --path <project> --script res://addons/ui_pro/builder.gd -- <spec.json>

const META_ID := "ui_pro_id"
const META_BASE := "ui_pro_base"

const ALLOWED_CLASSES := [
	"Control", "TextureRect", "NinePatchRect", "TextureButton", "TextureProgressBar", "Label"
]
const TEXTURE_PROPERTY := {
	"TextureRect": "texture",
	"NinePatchRect": "texture",
	"TextureButton": "texture_normal",
	"TextureProgressBar": "texture_progress",
}
const OFFSETS := ["offset_left", "offset_top", "offset_right", "offset_bottom"]
const PATCH_MARGINS := [
	"patch_margin_left", "patch_margin_top", "patch_margin_right", "patch_margin_bottom"
]
const NODE_PROPERTY := {
	"visible": "visible",
	"text": "text",
	"h_align": "horizontal_alignment",
	"v_align": "vertical_alignment",
}
const SETTINGS_PROPERTY := {
	"font_size": "font_size",
	"font_color": "font_color",
	"outline_size": "outline_size",
	"outline_color": "outline_color",
	"shadow_color": "shadow_color",
	"shadow_offset": "shadow_offset",
	"shadow_size": "shadow_size",
}
const H_ALIGN := {
	"left": HORIZONTAL_ALIGNMENT_LEFT,
	"center": HORIZONTAL_ALIGNMENT_CENTER,
	"right": HORIZONTAL_ALIGNMENT_RIGHT,
}
const V_ALIGN := {
	"top": VERTICAL_ALIGNMENT_TOP,
	"center": VERTICAL_ALIGNMENT_CENTER,
	"bottom": VERTICAL_ALIGNMENT_BOTTOM,
}
const COMMON_KEYS := ["name", "rect", "visible"]
const TEXT_ONLY_KEYS := [
	"text", "h_align", "v_align", "font_size", "font_color", "outline_size", "outline_color",
	"shadow_color", "shadow_offset", "shadow_size",
]

var _root: Control
var _by_id: Dictionary = {}
var _created: Array = []
var _updated: Array = []
var _removed: Array = []
var _conflicts: Array = []
var _errors: Array = []
var _dirty := false


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1:
		print("ERROR: builder.gd expects one argument: the spec file")
		quit(2)
		return
	var spec = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if typeof(spec) != TYPE_DICTIONARY:
		print("ERROR: cannot read the spec file ", args[0])
		quit(2)
		return
	_build(spec)
	_write_result(spec["result"], spec["scene"])
	quit(1 if _errors.size() > 0 else 0)


func _build(spec: Dictionary) -> void:
	var scene_path: String = spec["scene"]
	var specs: Array = spec["nodes"]
	var existed := ResourceLoader.exists(scene_path)
	if existed:
		var packed := load(scene_path) as PackedScene
		if packed == null:
			_error("scene_unloadable", "cannot load %s" % scene_path)
			return
		_root = packed.instantiate() as Control
		if _root == null or _root.get_meta(META_ID, "") != specs[0]["id"]:
			_error("scene_foreign", "%s was not created by ui-pro" % scene_path)
			return
		_index(_root)
	for node_spec: Dictionary in specs:
		var node: Control = _by_id.get(node_spec["id"])
		if node == null:
			_spawn(node_spec)
		else:
			_update(_align_class(node, node_spec), node_spec)
	_remove_stale(specs)
	_order_children(specs)
	if _errors.size() > 0:
		return
	if existed and not _dirty:
		return
	var packed_scene := PackedScene.new()
	var err := packed_scene.pack(_root)
	if err == OK:
		DirAccess.make_dir_recursive_absolute(
			ProjectSettings.globalize_path(scene_path.get_base_dir())
		)
		err = ResourceSaver.save(packed_scene, scene_path)
	if err != OK:
		_error("save_failed", "cannot save %s (error %d)" % [scene_path, err])


func _index(node: Node) -> void:
	if node.has_meta(META_ID) and (node == _root or node.owner == _root):
		var id: String = node.get_meta(META_ID)
		if _by_id.has(id):
			_conflict(id, "id", "", "", "duplicate_id")
		else:
			_by_id[id] = node
	for child in node.get_children():
		_index(child)


func _make(class_name_: String) -> Control:
	if not ALLOWED_CLASSES.has(class_name_):
		_error("class_unknown", "unsupported node class %s" % class_name_)
		return Control.new()
	return ClassDB.instantiate(class_name_) as Control


func _spawn(spec: Dictionary) -> void:
	var node := _make(spec["class"])
	var props: Dictionary = spec["props"]
	for key: String in spec["init"]:
		node.set(key, spec["init"][key])
	node.set_meta(META_ID, spec["id"])
	node.name = props["name"]
	var base := {}
	if spec["parent"] == null:
		_root = node
	else:
		var parent: Node = _by_id[spec["parent"]]
		parent.add_child(node)
		node.owner = _root
		base["parent"] = spec["parent"]
		if str(node.name) != props["name"]:
			_conflict(spec["id"], "name", props["name"], str(node.name), "name_taken")
	node.unique_name_in_owner = true
	for key: String in props:
		if _applies(node, key):
			_write(node, key, _decode(key, props[key]))
			base[key] = props[key]
	node.set_meta(META_BASE, base)
	_by_id[spec["id"]] = node
	_created.append(spec["id"])
	_dirty = true

func _applies(node: Control, key: String) -> bool:
	if key == "texture":
		return TEXTURE_PROPERTY.has(node.get_class())
	if key == "patch_margin":
		return node.get_class() == "NinePatchRect"
	if TEXT_ONLY_KEYS.has(key):
		return node.get_class() == "Label"
	return true


## Replaces a node whose Godot class changed (for example an image that gained nine-slice margins).
func _align_class(node: Control, spec: Dictionary) -> Control:
	if node.get_class() == spec["class"]:
		return node
	if node == _root or node.get_script() != null:
		_conflict(spec["id"], "class", spec["class"], node.get_class(), "class_kept")
		return node
	var fresh := _make(spec["class"])
	var parent := node.get_parent()
	var name_ := node.name
	for key: String in spec["init"]:
		fresh.set(key, spec["init"][key])
	for key in COMMON_KEYS:
		_write(fresh, key, _read(node, key))
	var old_base: Dictionary = node.get_meta(META_BASE, {})
	var base := {}
	for key in COMMON_KEYS:
		if old_base.has(key):
			base[key] = old_base[key]
	fresh.set_meta(META_ID, spec["id"])
	fresh.set_meta(META_BASE, base)
	fresh.name = "_ui_pro_replacing"
	parent.add_child(fresh)
	parent.move_child(fresh, node.get_index())
	fresh.owner = _root
	for child in node.get_children():
		_move(child, fresh)
	parent.remove_child(node)
	node.free()
	fresh.name = name_
	fresh.unique_name_in_owner = true
	_by_id[spec["id"]] = fresh
	_dirty = true
	return fresh


## Reparents without the engine's inconsistent-owner warning; descendants keep their owner.
func _move(node: Node, parent: Node) -> void:
	node.owner = null
	node.get_parent().remove_child(node)
	parent.add_child(node)
	node.owner = _root

func _update(node: Control, spec: Dictionary) -> void:
	var original: Dictionary = node.get_meta(META_BASE, {})
	var base := original.duplicate(true)
	var changed: Array = []
	_place(node, spec, base, changed)
	var props: Dictionary = spec["props"]
	for key: String in props:
		if _applies(node, key):
			_merge(node, spec["id"], key, props[key], base, changed)
	if base.hash() != original.hash():
		node.set_meta(META_BASE, base)
		_dirty = true
	if changed.size() > 0:
		_updated.append({"id": spec["id"], "keys": changed})
		_dirty = true


## Three-way merge of one tool-owned property: the value last exported (base), the value in the
## scene now (current) and the value the screen asks for now (new).
func _merge(node: Control, id: String, key: String, raw: Variant, base: Dictionary, changed: Array) -> void:
	var wanted = _decode(key, raw)
	var current = _read(node, key)
	var exported = _decode(key, base[key]) if base.has(key) else current
	if _same(current, exported):
		if not _same(current, wanted):
			if not _write(node, key, wanted):
				_conflict(id, key, raw, _jsonable(current), "shared_resource")
				return
			changed.append(key)
		base[key] = raw
	elif _same(wanted, exported):
		return
	elif _same(wanted, current):
		base[key] = raw
	else:
		_conflict(id, key, raw, _jsonable(current), "both_changed")


func _place(node: Control, spec: Dictionary, base: Dictionary, changed: Array) -> void:
	if spec["parent"] == null:
		return
	var want: Node = _by_id[spec["parent"]]
	var parent := node.get_parent()
	if parent == want:
		base["parent"] = spec["parent"]
		return
	var current_id: String = parent.get_meta(META_ID, "")
	var exported_id: String = base.get("parent", current_id)
	if current_id != exported_id:
		if spec["parent"] != exported_id:
			_conflict(spec["id"], "parent", spec["parent"], current_id, "moved_in_both")
		return
	_move(node, want)
	base["parent"] = spec["parent"]
	changed.append("parent")


func _remove_stale(specs: Array) -> void:
	var wanted := {}
	for node_spec: Dictionary in specs:
		wanted[node_spec["id"]] = true
	var stale: Array = []
	for id: String in _by_id:
		if not wanted.has(id):
			stale.append(_by_id[id])
	stale.sort_custom(func(a: Node, b: Node) -> bool: return _depth(a) > _depth(b))
	var kept := {}
	for node: Node in stale:
		var id: String = node.get_meta(META_ID)
		var blocker := _removal_blocker(node, wanted, kept)
		if blocker != "":
			kept[id] = true
			_conflict(id, "removal", "", "", blocker)
			continue
		node.get_parent().remove_child(node)
		node.free()
		_by_id.erase(id)
		_removed.append(id)
		_dirty = true


func _removal_blocker(node: Node, wanted: Dictionary, kept: Dictionary) -> String:
	if node.get_script() != null:
		return "removal_has_script"
	for child in node.find_children("*", "", true, false):
		if not child.has_meta(META_ID):
			return "removal_has_user_nodes"
		var id: String = child.get_meta(META_ID)
		if wanted.has(id) or kept.has(id):
			return "removal_holds_nodes"
		if child.get_script() != null:
			return "removal_has_script"
	return ""


func _depth(node: Node) -> int:
	var depth := 0
	var current := node
	while current != _root and current != null:
		depth += 1
		current = current.get_parent()
	return depth


## Tool nodes take the child slots tool nodes already hold; user nodes keep their positions.
func _order_children(specs: Array) -> void:
	var by_parent := {}
	for node_spec: Dictionary in specs:
		if node_spec["parent"] != null:
			if not by_parent.has(node_spec["parent"]):
				by_parent[node_spec["parent"]] = []
			by_parent[node_spec["parent"]].append(_by_id[node_spec["id"]])
	for parent_id: String in by_parent:
		var parent: Node = _by_id[parent_id]
		var tool_children: Array = by_parent[parent_id].filter(
			func(child: Node) -> bool: return child.get_parent() == parent
		)
		var desired: Array = []
		var next := 0
		for child in parent.get_children():
			if tool_children.has(child):
				desired.append(tool_children[next])
				next += 1
			else:
				desired.append(child)
		for index in desired.size():
			if parent.get_child(index) != desired[index]:
				parent.move_child(desired[index], index)
				_dirty = true


func _decode(key: String, raw: Variant) -> Variant:
	match key:
		"font_color", "outline_color", "shadow_color":
			return Color.html(raw)
		"shadow_offset":
			return Vector2(raw[0], raw[1])
		"h_align":
			return H_ALIGN[raw]
		"v_align":
			return V_ALIGN[raw]
		"font_size", "outline_size", "shadow_size":
			return int(raw)
		_:
			return raw


func _read(node: Control, key: String) -> Variant:
	match key:
		"name":
			return str(node.name)
		"rect":
			return OFFSETS.map(func(property: String) -> float: return node.get(property))
		"patch_margin":
			return PATCH_MARGINS.map(func(property: String) -> float: return node.get(property))
		"texture":
			var texture := node.get(TEXTURE_PROPERTY[node.get_class()]) as Texture2D
			return "" if texture == null else texture.resource_path
	if NODE_PROPERTY.has(key):
		return node.get(NODE_PROPERTY[key])
	return _settings(node).get(SETTINGS_PROPERTY[key])


func _write(node: Control, key: String, value: Variant) -> bool:
	match key:
		"name":
			node.name = value
			return true
		"rect":
			for index in 4:
				node.set(OFFSETS[index], value[index])
			return true
		"patch_margin":
			for index in 4:
				node.set(PATCH_MARGINS[index], int(value[index]))
			return true
		"texture":
			return _write_texture(node, value)
	if NODE_PROPERTY.has(key):
		node.set(NODE_PROPERTY[key], value)
		return true
	var settings := _settings(node)
	if settings.resource_path != "" and not settings.resource_path.contains("::"):
		return false
	settings.set(SETTINGS_PROPERTY[key], value)
	return true


func _write_texture(node: Control, path: String) -> bool:
	var texture: Texture2D = null
	if path != "":
		texture = load(path) as Texture2D
		if texture == null:
			_error("texture_missing", "cannot load the texture %s" % path)
			return true
	node.set(TEXTURE_PROPERTY[node.get_class()], texture)
	return true


func _settings(node: Control) -> LabelSettings:
	var settings := node.get("label_settings") as LabelSettings
	if settings == null:
		settings = LabelSettings.new()
		node.set("label_settings", settings)
	return settings


func _same(a: Variant, b: Variant) -> bool:
	var number_a := typeof(a) == TYPE_INT or typeof(a) == TYPE_FLOAT
	var number_b := typeof(b) == TYPE_INT or typeof(b) == TYPE_FLOAT
	if number_a and number_b:
		return absf(float(a) - float(b)) < 0.001
	if typeof(a) != typeof(b):
		return false
	if typeof(a) == TYPE_ARRAY:
		if a.size() != b.size():
			return false
		for index in a.size():
			if not _same(a[index], b[index]):
				return false
		return true
	if typeof(a) == TYPE_COLOR or typeof(a) == TYPE_VECTOR2:
		return a.is_equal_approx(b)
	return a == b


func _jsonable(value: Variant) -> Variant:
	match typeof(value):
		TYPE_COLOR:
			return "#" + value.to_html(true)
		TYPE_VECTOR2:
			return [value.x, value.y]
		_:
			return value


func _conflict(id: String, key: String, wanted: Variant, found: Variant, reason: String) -> void:
	_conflicts.append({"id": id, "key": key, "design": wanted, "scene": found, "reason": reason})


func _error(code: String, message: String) -> void:
	_errors.append({"code": code, "message": message})
	print("ERROR: [", code, "] ", message)


func _write_result(path: String, scene_path: String) -> void:
	var result := {
		"ok": _errors.size() == 0,
		"scene": scene_path,
		"created": _created,
		"updated": _updated,
		"removed": _removed,
		"conflicts": _conflicts,
		"errors": _errors,
	}
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(result))
	if _root != null:
		_root.free()
