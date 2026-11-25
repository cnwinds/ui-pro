extends SceneTree

var _frames := 0

func _init() -> void:
	var scene: PackedScene = load("res://probe.tscn")
	root.add_child(scene.instantiate())

func _process(_delta: float) -> bool:
	_frames += 1
	if _frames == 3:
		var img := root.get_texture().get_image()
		print("shot=", img.save_png("res://shot.png"), " size=", img.get_size())
		return true
	return false
