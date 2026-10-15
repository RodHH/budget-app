// Web push on this device. iPhone requires iOS 16.4+ and the app opened from the Home Screen.
import { api } from './lib.js';

export function deviceInfo() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const secure = window.isSecureContext;
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  const m = ua.match(/OS (\d+)_(\d+)/);
  const iosTooOld = ios && m ? Number(m[1]) < 16 || (Number(m[1]) === 16 && Number(m[2]) < 4) : false;
  return { ios, standalone, supported, secure, permission, iosTooOld };
}

export function pushReadiness(info, serverConfigured) {
  if (!serverConfigured) return { state: 'server', text: 'The server doesn’t have push set up yet.' };
  if (!info.secure) return { state: 'blocked', text: 'Notifications need the app to be opened over HTTPS.' };
  if (info.ios && !info.standalone) return { state: 'install', text: 'On iPhone, add this app to your Home Screen first, then open it from there to turn on notifications.' };
  if (info.iosTooOld) return { state: 'blocked', text: 'iPhone web notifications need iOS 16.4 or later.' };
  if (!info.supported) return { state: 'blocked', text: 'This browser doesn’t support web push notifications.' };
  if (info.permission === 'denied') return { state: 'denied', text: 'Notifications are blocked for this app. On iPhone: Settings → Notifications → Budget → Allow Notifications.' };
  return { state: 'ready', text: '' };
}

function keyToBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Must be called from a tap (iOS only shows the permission prompt in response to a user gesture). */
export async function enablePush(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications weren’t allowed. You can change this in Settings → Notifications.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
  const info = deviceInfo();
  const label = info.ios ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'This device';
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), label });
  return sub;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
}
