/**
 * Prints a new VAPID key pair for Web Push. Put both lines in the server's .env
 * once; changing them later turns off notifications on every device until the
 * member enables them again.
 */
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY="${keys.publicKey}"`);
console.log(`VAPID_PRIVATE_KEY="${keys.privateKey}"`);
