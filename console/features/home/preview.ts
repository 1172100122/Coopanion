/** A static avatar links to the live dressing preview without starting another pet renderer. */
export function createPetPreview(doc: Document, label: string, open: () => void, signal: AbortSignal): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'home-petpreview';
  const image = doc.createElement('img');
  image.src = '/api/avatar';
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener('error', () => { image.hidden = true; }, { signal });
  const hint = doc.createElement('span');
  hint.textContent = label;
  button.append(image, hint);
  button.addEventListener('click', open, { signal });
  return button;
}
