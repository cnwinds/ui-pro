extends SceneTree

func _init() -> void:
	var root := Control.new()
	root.name = "Probe"
	root.size = Vector2(438, 652)
	var tex := TextureRect.new()
	tex.name = "Bg"
	tex.texture = load("res://ui.png")
	tex.set_meta("ui_pro_id", "bg")
	tex.unique_name_in_owner = true
	root.add_child(tex)
	tex.owner = root
	var packed := PackedScene.new()
	print("pack=", packed.pack(root))
	print("save=", ResourceSaver.save(packed, "res://probe.tscn"))
	quit()
