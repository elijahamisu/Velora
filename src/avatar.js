// Altivex · profile photo helpers (register.html, profile.html, user shell)
//
// Photos live in the public Storage bucket "avatars" at
//   <user_id>/avatar-<timestamp>.<ext>
// Storage policies only let a signed-in user write inside their own <uid>/
// folder, and the profiles trigger only accepts an avatar_url that points
// into that folder (see supabase/schema.sql, "avatars hardening").

export const AVATAR_BUCKET = 'avatars';
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const AVATAR_MAX_INPUT = 10 * 1024 * 1024; // what we accept from the picker (it is resized before upload)
export const AVATAR_MAX_UPLOAD = 2 * 1024 * 1024; // bucket limit; resized output is far below this
export const AVATAR_SIZE = 512;

export function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'A';
    const a = parts[0].charAt(0);
    const b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
}

/** Throws an Error with a user-facing message when the file is not usable. */
export function validateAvatarFile(file) {
    if (!file) throw new Error('No file selected.');
    if (!AVATAR_TYPES.includes(file.type)) throw new Error('Please choose a JPG, PNG or WebP image.');
    if (file.size > AVATAR_MAX_INPUT) throw new Error('That image is too large. Please choose one under 10 MB.');
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
        img.src = url;
    });
}

function toBlob(canvas, type, quality) {
    return new Promise(resolve => canvas.toBlob(b => resolve(b), type, quality));
}

/**
 * Centre-crops to a square, scales to at most 512px and re-encodes
 * (WebP where the browser can, JPEG otherwise). Returns { blob, ext, type }.
 */
export async function prepareAvatar(file) {
    validateAvatarFile(file);
    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('Could not read that image.');
    const out = Math.min(AVATAR_SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);

    let blob = await toBlob(canvas, 'image/webp', 0.86);
    let type = 'image/webp', ext = 'webp';
    if (!blob || blob.type !== 'image/webp') {
        blob = await toBlob(canvas, 'image/jpeg', 0.86);
        type = 'image/jpeg'; ext = 'jpg';
    }
    if (!blob) throw new Error('Could not process that image.');
    if (blob.size > AVATAR_MAX_UPLOAD) throw new Error('That image is too large after compression.');
    return { blob, ext, type };
}

/** Old-format and own-folder objects other than `keepPath` are removed (best effort). */
async function cleanupOld(supabase, userId, keepPath) {
    try {
        const { data } = await supabase.storage.from(AVATAR_BUCKET).list(userId, { limit: 100 });
        const stale = (data || []).map(o => `${userId}/${o.name}`).filter(p => p !== keepPath);
        if (stale.length) await supabase.storage.from(AVATAR_BUCKET).remove(stale);
    } catch (_) { /* non-fatal */ }
}

/**
 * Uploads a prepared avatar for the signed-in user and stores its public URL
 * on profiles.avatar_url. Returns the public URL.
 */
export async function uploadAvatar(supabase, userId, prepared) {
    const path = `${userId}/avatar-${Date.now()}.${prepared.ext}`;
    const { error: upErr } = await supabase.storage.from(AVATAR_BUCKET)
        .upload(path, prepared.blob, { contentType: prepared.type, cacheControl: '31536000', upsert: false });
    if (upErr) throw upErr;
    const { data: { publicUrl } } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
    const { error: dbErr } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', userId);
    if (dbErr) {
        await supabase.storage.from(AVATAR_BUCKET).remove([path]).catch(() => {});
        throw dbErr;
    }
    await cleanupOld(supabase, userId, path);
    notifyShell(publicUrl);
    return publicUrl;
}

/** Clears profiles.avatar_url and deletes the user's stored photos. */
export async function removeAvatar(supabase, userId) {
    const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', userId);
    if (error) throw error;
    await cleanupOld(supabase, userId, null);
    notifyShell(null);
}

function notifyShell(url) {
    try { window.AXShell?.setAvatar(url); } catch (_) { /* shell not on this page */ }
}
