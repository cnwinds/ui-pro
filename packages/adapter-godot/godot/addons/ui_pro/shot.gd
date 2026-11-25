extends SceneTree
## Renders a scene for a few frames and saves it as a PNG. Needs a window: headless mode does
## not render.
## godot --path <project> --script res://addons/ui_pro/shot.gd -- <scene> <out.png> <width> <height>

const WARMUP_FRAMES := 5

var _viewport: SubViewport
var _out := ""
var _frames := 0


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 4:
		print("ERROR: shot.gd expects <scene> <out.png> <width> <height>")
		quit(2)
		return
	var scene := load(args[0]) as PackedScene
	if scene == null:
		print("ERROR: cannot load the scene ", args[0])
		quit(2)
		return
	_out = args[1]
	_viewport = SubViewport.new()
	_viewport.size = Vector2i(int(args[2]), int(args[3]))
	_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(_viewport)
	_viewport.add_child(scene.instantiate())


func _process(_delta: float) -> bool:
	if _viewport == null:
		return true
	_frames += 1
	if _frames < WARMUP_FRAMES:
		return false
	var err := _viewport.get_texture().get_image().save_png(_out)
	if err != OK:
		print("ERROR: cannot save ", _out, " (error ", err, ")")
		quit(1)
	return true
