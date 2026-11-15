// SPDX-License-Identifier: GPL-3.0-or-later
//
// Clips an actor to a rectangle with rounded corners, the way the overview
// clips the background of a workspace.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

const DECLARATIONS = `
uniform vec4 texture_box;
uniform vec4 clip_bounds;
uniform float clip_radius;
`;

// Signed distance to the rounded rectangle, turned into one pixel of antialiasing.
const CODE = `
vec2 position = texture_box.xy + cogl_tex_coord_in[0].xy * texture_box.zw;
vec2 center = (clip_bounds.xy + clip_bounds.zw) / 2.0;
vec2 half_size = (clip_bounds.zw - clip_bounds.xy) / 2.0;
vec2 corner = abs(position - center) - half_size + clip_radius;
float distance = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - clip_radius;
cogl_color_out *= clamp(0.5 - distance, 0.0, 1.0);
`;

export const RoundedClipEffect = GObject.registerClass(
class RoundedClipEffect extends Clutter.ShaderEffect {
    vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
    }

    /** In the actor's own coordinates. */
    setClip(x1, y1, x2, y2, radius) {
        this.set_uniform_float('clip_bounds', 4, [x1, y1, x2, y2]);
        this.set_uniform_float('clip_radius', 1, [radius]);
    }

    vfunc_paint_target(node, paintContext) {
        // The offscreen texture is larger than the actor: Clutter pads it by
        // a few pixels and ends it at ceil(edge + 0.75) on the right and the
        // bottom (_clutter_actor_box_enlarge_for_effects).
        const actor = this.get_actor();
        const [, textureWidth, textureHeight] = this.get_target_size();
        const scale = actor.get_resource_scale();
        const width = textureWidth / scale;
        const height = textureHeight / scale;
        this.set_uniform_float('texture_box', 4, [
            Math.ceil(actor.width + 0.75) - width, Math.ceil(actor.height + 0.75) - height, width, height,
        ]);
        super.vfunc_paint_target(node, paintContext);
    }
});
