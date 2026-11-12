// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shell (and extensions such as Blur my Shell) draws copies of the system
// background where windows are not shown: behind the overview and its
// workspaces, behind blurred panels. Each copy gets a clone of the wallpaper
// on top, and so do the workspace thumbnails, which have no background at all.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import {BackgroundManager} from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspaceBackground} from 'resource:///org/gnome/shell/ui/workspace.js';
import {WorkspaceThumbnail} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {RoundedClipEffect} from './roundedClip.js';

export class BackgroundClones {
    /** `getWallpaperActor(monitorIndex)` returns the wallpaper's window actor on a monitor, or null. */
    constructor(getWallpaperActor) {
        this._getWallpaperActor = getWallpaperActor;
        // Clutter.Clone of the wallpaper, on a copy of the system background → monitor index.
        this._backgrounds = new Map();
        // WorkspaceThumbnail → Clutter.Clone of the wallpaper on its monitor.
        this._thumbnails = new Map();

        const clones = this;
        // Never let the wallpaper break the shell's own code.
        const guarded = (method, ...args) => {
            try {
                method.apply(this, args);
            } catch (e) {
                logError(e, 'Paper Engine: wallpaper clone');
            }
        };
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(BackgroundManager.prototype, '_createBackgroundActor',
            original => function () {
                const backgroundActor = original.call(this);
                guarded(clones._addBackgroundClone, backgroundActor);
                return backgroundActor;
            });
        // setPorthole runs when a thumbnail is built.
        this._injectionManager.overrideMethod(WorkspaceThumbnail.prototype, 'setPorthole',
            original => function (...args) {
                original.apply(this, args);
                guarded(clones._syncThumbnailClone, this);
            });
        const addToExisting = actor => {
            if (actor instanceof Meta.BackgroundActor)
                guarded(this._addBackgroundClone, actor);
            else
                actor.get_children().forEach(addToExisting);
        };
        addToExisting(global.stage);
    }

    destroy() {
        this._injectionManager.clear();
        [...this._backgrounds.keys()].forEach(clone => clone.destroy());
        [...this._thumbnails.values()].forEach(clone => clone.destroy());
    }

    /** Points every clone at the wallpaper windows there are now. */
    sync() {
        for (const clone of this._backgrounds.keys())
            this._syncBackgroundClone(clone);
        for (const thumbnail of this._thumbnails.keys())
            this._syncThumbnailClone(thumbnail);
    }

    // A thumbnail shows its windows at their place on the screen, scaled down.
    _syncThumbnailClone(thumbnail) {
        let clone = this._thumbnails.get(thumbnail);
        if (!clone) {
            clone = new Clutter.Clone();
            clone.connect('destroy', () => this._thumbnails.delete(thumbnail));
            this._thumbnails.set(thumbnail, clone);
            thumbnail._contents.insert_child_below(clone, null);
        }
        const monitor = Main.layoutManager.monitors[thumbnail.monitorIndex];
        clone.set_position(monitor.x, monitor.y);
        clone.set_size(monitor.width, monitor.height);
        clone.source = this._getWallpaperActor(thumbnail.monitorIndex);
        clone.visible = clone.source !== null;
    }

    _addBackgroundClone(backgroundActor) {
        const container = backgroundActor.get_parent();
        // The desktop is covered by the wallpaper's own window, and the lock
        // screen gets clones of its own (see _syncLockScreenClones).
        if (container === Main.layoutManager._backgroundGroup ||
            container.has_style_class_name?.('screen-shield-background'))
            return;

        // A clone asks for the size of its source, and the overview would
        // lay a workspace out around that; the background asks for nothing
        // and is given the space there is.
        const clone = new Clutter.Clone({min_width: 0, min_height: 0, natural_width: 0, natural_height: 0});
        clone.add_constraint(new Clutter.BindConstraint({
            source: backgroundActor, coordinate: Clutter.BindCoordinate.SIZE,
        }));
        clone.connect('destroy', () => this._backgrounds.delete(clone));
        this._backgrounds.set(clone, backgroundActor.monitor);
        backgroundActor.add_child(clone);
        this._syncBackgroundClone(clone);

        // The overview clips the background of a workspace to its work area,
        // with corners that round as the overview opens.
        const workspaceBackground = container.get_parent()?.get_parent();
        if (workspaceBackground instanceof WorkspaceBackground) {
            const effect = new RoundedClipEffect();
            clone.add_effect(effect);
            const clip = () => this._clipToWorkArea(workspaceBackground, backgroundActor, effect);
            backgroundActor.connect('notify::allocation', clip);
            backgroundActor.content.connect('notify::rounded-clip-radius', clip);
            clip();
        }
    }

    _syncBackgroundClone(clone) {
        clone.source = this._getWallpaperActor(this._backgrounds.get(clone));
        clone.visible = clone.source !== null;
    }

    _clipToWorkArea(workspaceBackground, backgroundActor, effect) {
        const monitor = Main.layoutManager.monitors[workspaceBackground._monitorIndex];
        const workArea = workspaceBackground._workarea;
        const {width, height} = backgroundActor;
        const scaleX = width / monitor.width;
        const scaleY = height / monitor.height;
        const left = (workArea.x - monitor.x) * scaleX;
        const top = (workArea.y - monitor.y) * scaleY;
        effect.setClip(
            width, height,
            left, top, left + workArea.width * scaleX, top + workArea.height * scaleY,
            backgroundActor.content.rounded_clip_radius * scaleX);
    }
}
