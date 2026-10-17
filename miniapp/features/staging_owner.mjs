// Isolated owner preview only; never a public-bot authentication fallback.
import {telegramPublicUser} from './telegram_signature.mjs';
export const MAIN_BOT_ID='8840929072'; // Existing receipt: docs/telegram-reactions.md.
export function ownerPreviewEnabled(env){return env.STAGING_OWNER_PREVIEW==='1'&&/^[1-9]\d{4,13}$/.test(String(env.MINIAPP_ADMIN_ID??''));}
export function ownerPreviewRoute(path,method){return ({'/api/admin/superfind':'GET','/api/admin/superfind/settings':'PUT','/api/admin/superfind/decision':'POST','/api/admin/superfind/refresh':'POST','/api/admin/superfind/job':'GET'})[path]===method;}
export async function stagingAdminUser(raw,env){if(!ownerPreviewEnabled(env))throw Error('OWNER_PREVIEW_DISABLED');return telegramPublicUser(raw,MAIN_BOT_ID);}
