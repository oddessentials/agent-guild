# Checks that Yard models import into Godot 4 and retarget by its humanoid
# profile: every profile bone the contract names is present, with the
# profile's parent, and every contract clip imports as an animation.
#
#   python ../build.py WORLD godot [name ...]   (copies the models here, imports, runs this)
#   godot --headless --path . --script res://check.gd -- model.glb ...
extends SceneTree

const CLIPS = {
	"character": ["walk", "work_0", "work_1", "pause", "idle_0", "idle_1", "idle_2", "done"],
	"helper": ["idle", "working", "waiting", "done", "move"],
}

func _init():
	var failed := 0
	var profile := SkeletonProfileHumanoid.new()
	for file in OS.get_cmdline_user_args():
		var scene: PackedScene = load("res://" + file)
		if scene == null:
			print("YARD_GODOT fail %s: did not import" % file); failed += 1; continue
		var root := scene.instantiate()
		var skeleton: Skeleton3D = root.find_children("*", "Skeleton3D", true, false).front()
		var kind := "character" if skeleton.find_bone("LeftUpperLeg") >= 0 else "helper"
		var problems := []
		for i in profile.bone_size:
			var bone := profile.get_bone_name(i)
			# The contract leaves out fingers and eyes, which the profile allows.
			if not profile.is_required(i) and skeleton.find_bone(bone) < 0:
				continue
			if kind == "helper" and not bone in ["Hips", "Spine", "Chest", "UpperChest", "Neck", "Head"]:
				continue
			var index := skeleton.find_bone(bone)
			if index < 0:
				problems.append("no " + bone); continue
			var parent := profile.get_bone_parent(i)
			if parent != &"" and skeleton.get_bone_name(skeleton.get_bone_parent(index)) != parent:
				problems.append("%s under %s, not %s" % [bone, skeleton.get_bone_name(skeleton.get_bone_parent(index)), parent])
		var player: AnimationPlayer = root.find_children("*", "AnimationPlayer", true, false).front()
		for clip in CLIPS[kind]:
			if player == null or not player.has_animation(clip):
				problems.append("no clip " + clip)
		if problems.is_empty():
			print("YARD_GODOT ok %s (%s, %d bones)" % [file, kind, skeleton.get_bone_count()])
		else:
			print("YARD_GODOT fail %s: %s" % [file, ", ".join(problems)]); failed += 1
		root.free()
	quit(1 if failed else 0)
