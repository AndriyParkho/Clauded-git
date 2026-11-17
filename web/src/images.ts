import type { ImageAttachment, ImageMediaType } from '../../shared/protocol';

/** Claude ramène toute image à 1568 px de grand côté : inutile d'envoyer plus (et ça coûte des tokens). */
const MAX_SIDE = 1568;
const ACCEPTED: ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function isAccepted(type: string): type is ImageMediaType {
    return (ACCEPTED as string[]).includes(type);
}

function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'));
        reader.readAsDataURL(blob);
    });
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('image illisible'));
        image.src = url;
    });
}

/** Convertit un fichier image en pièce jointe base64, réduite si elle dépasse `MAX_SIDE`. */
export async function toAttachment(file: Blob & { name?: string }): Promise<ImageAttachment> {
    const type = file.type || 'image/png';
    if (!type.startsWith('image/')) throw new Error(`pas une image : ${type}`);
    const url = await readAsDataUrl(file);
    const image = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const name = file.name ? { name: file.name } : {};

    if (scale === 1 && isAccepted(type) && type !== 'image/gif') {
        return { mediaType: type, data: url.slice(url.indexOf(',') + 1), ...name };
    }
    // Réduction (ou conversion d'un format non accepté, comme BMP ou TIFF) via un canvas, en PNG.
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas indisponible');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mediaType: ImageMediaType = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const out = canvas.toDataURL(mediaType, 0.92);
    return { mediaType, data: out.slice(out.indexOf(',') + 1), ...name };
}

/** Les images d'un collage ou d'un glisser-déposer. */
export function imageFiles(transfer: DataTransfer | null): File[] {
    if (!transfer) return [];
    const files: File[] = [];
    for (const item of Array.from(transfer.items ?? [])) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) files.push(file);
        }
    }
    if (files.length === 0) for (const file of Array.from(transfer.files ?? [])) if (file.type.startsWith('image/')) files.push(file);
    return files;
}
