// SPDX-License-Identifier: GPL-3.0-or-later
//
// Clips an actor to a rectangle with rounded corners, the way the overview
// clips the background of a workspace.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

const DECLARATIONS = `
uniform vec2 actor_size;
uniform vec4 clip_bounds;
uniform float clip_radius;
`;

// Signed distance to the rounded rectangle, turned into one pixel of antialiasing.
const CODE = `
vec2 position = cogl_tex_coord_in[0].xy * actor_size;
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

    /** Everything is in the actor's own coordinates. */
    setClip(width, height, x1, y1, x2, y2, radius) {
        this.set_uniform_float('actor_size', 2, [width, height]);
        this.set_uniform_float('clip_bounds', 4, [x1, y1, x2, y2]);
        this.set_uniform_float('clip_radius', 1, [radius]);
    }
});
