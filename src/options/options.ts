// ============================================================
// AheadSub — Options Page Script
// ============================================================

import { MessageType } from '../core/messages';
import { DEFAULT_SETTINGS } from '../core/constants';
import type { AheadSubSettings } from '../core/types';

async function init(): Promise<void> {
  const response: any = await chrome.runtime.sendMessage({ type: MessageType.GET_SETTINGS });
  const settings: AheadSubSettings = response?.settings || DEFAULT_SETTINGS;
  applyToUI(settings);
  setupListeners();
}

function applyToUI(s: AheadSubSettings): void {
  (document.getElementById('fontSize') as HTMLInputElement).value = String(s.fontSize);
  document.getElementById('fontSizeValue')!.textContent = `${s.fontSize}px`;
  (document.getElementById('fontColor') as HTMLInputElement).value = s.fontColor;
  (document.getElementById('outlineColor') as HTMLInputElement).value = s.outlineColor;
  (document.getElementById('outlineWidth') as HTMLInputElement).value = String(s.outlineWidth);
  document.getElementById('outlineWidthValue')!.textContent = `${s.outlineWidth}px`;
  (document.getElementById('subtitlePosition') as HTMLSelectElement).value = s.subtitlePosition;
  (document.getElementById('maxCharsPerLine') as HTMLInputElement).value = String(s.maxCharsPerLine);
  (document.getElementById('maxLines') as HTMLSelectElement).value = String(s.maxLines);
  (document.getElementById('aheadBuffer') as HTMLInputElement).value = String(s.aheadBufferSeconds);
  (document.getElementById('useWebGPU') as HTMLInputElement).checked = s.useWebGPU;
  (document.getElementById('translationMode') as HTMLSelectElement).value = s.translationMode;
  (document.getElementById('cloudProvider') as HTMLSelectElement).value = s.cloudApiProvider || 'google';
  (document.getElementById('cloudApiKey') as HTMLInputElement).value = s.cloudApiKey || '';
  toggleCloudOptions(s.translationMode);
}

function gatherFromUI(): AheadSubSettings {
  return {
    ...DEFAULT_SETTINGS,
    fontSize: parseInt((document.getElementById('fontSize') as HTMLInputElement).value),
    fontColor: (document.getElementById('fontColor') as HTMLInputElement).value,
    outlineColor: (document.getElementById('outlineColor') as HTMLInputElement).value,
    outlineWidth: parseInt((document.getElementById('outlineWidth') as HTMLInputElement).value),
    subtitlePosition: (document.getElementById('subtitlePosition') as HTMLSelectElement).value as any,
    maxCharsPerLine: parseInt((document.getElementById('maxCharsPerLine') as HTMLInputElement).value),
    maxLines: parseInt((document.getElementById('maxLines') as HTMLSelectElement).value),
    aheadBufferSeconds: parseInt((document.getElementById('aheadBuffer') as HTMLInputElement).value),
    useWebGPU: (document.getElementById('useWebGPU') as HTMLInputElement).checked,
    translationMode: (document.getElementById('translationMode') as HTMLSelectElement).value as any,
    cloudApiProvider: (document.getElementById('cloudProvider') as HTMLSelectElement).value as any,
    cloudApiKey: (document.getElementById('cloudApiKey') as HTMLInputElement).value || undefined,
  };
}

function toggleCloudOptions(mode: string): void {
  const cloudOpts = document.querySelectorAll('.cloud-option');
  cloudOpts.forEach(el => {
    (el as HTMLElement).style.display = mode === 'cloud' ? 'flex' : 'none';
  });
}

function setupListeners(): void {
  document.getElementById('fontSize')!.addEventListener('input', (e) => {
    document.getElementById('fontSizeValue')!.textContent = `${(e.target as HTMLInputElement).value}px`;
  });
  document.getElementById('outlineWidth')!.addEventListener('input', (e) => {
    document.getElementById('outlineWidthValue')!.textContent = `${(e.target as HTMLInputElement).value}px`;
  });
  document.getElementById('translationMode')!.addEventListener('change', (e) => {
    toggleCloudOptions((e.target as HTMLSelectElement).value);
  });
  document.getElementById('saveBtn')!.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MessageType.SAVE_SETTINGS, payload: gatherFromUI() });
    const btn = document.getElementById('saveBtn')!;
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = 'Save Settings'; }, 2000);
  });
  document.getElementById('resetBtn')!.addEventListener('click', () => {
    applyToUI(DEFAULT_SETTINGS);
  });
  document.getElementById('clearAllCache')!.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: MessageType.CLEAR_CACHE });
    document.getElementById('cacheInfo')!.textContent = 'Cache cleared.';
  });
}

init();
