'use strict';
// Standalone Render diagnostic. Node.js 22+; no npm packages or other project files.
// Put this file beside the package.json used by Render. Temporary Start Command: node diagnose.cjs
// Credentials are read from Render Environment; never put secrets in this file.
const { createServer } = require('node:http');

const ACCOUNTS = Object.freeze({
  bot: { variable: 'DISCORD_BOT_TOKEN', label: 'البوت الرسمي', apiVersion: 10 },
  observer: { variable: 'ARENA_USER_TOKEN', label: 'حساب القارئ', apiVersion: 9 }
});

// Tokens are opaque. Do not decode them or enforce historical token lengths.
function readToken(env, variable, warnings) {
  const raw = env[variable];
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`المتغير ${variable} مطلوب.`);
  let token = raw.trim();
  if (/^(["']).*\1$/s.test(token)) {
    token = token.slice(1, -1).trim();
    warnings.push(`${variable}: أزيلت علامتا الاقتباس المحيطتان بالقيمة.`);
  }
  if (/^(Bot|Bearer)\s+/i.test(token)) {
    token = token.replace(/^(Bot|Bearer)\s+/i, '').trim();
    warnings.push(`${variable}: أزيلت بادئة Authorization؛ يكفي وضع التوكن وحده في Environment.`);
  }
  if (!token || /[\s\p{C}]/u.test(token) || /[^\x21-\x7e]|["'`]/.test(token)
    || /^(DISCORD_BOT_TOKEN|ARENA_USER_TOKEN)\s*=/.test(token)) {
    throw new Error(`${variable}: تنسيق القيمة غير صالح؛ ضع التوكن وحده دون اسم المتغير أو أسطر أو محارف خفية داخله.`);
  }
  return token;
}

function readAuthConfig(env = process.env) {
  const mode = env.OBSERVER_MODE?.trim() || 'selfbot';
  if (!['selfbot', 'official'].includes(mode)) throw new Error('OBSERVER_MODE: official أو selfbot فقط.');
  if (mode === 'selfbot' && env.ACKNOWLEDGE_SELFBOT_RISK?.trim() !== 'true') {
    throw new Error('الـself-bot مخالف لشروط Discord وقد يغلق الحساب. راجع README ثم ACKNOWLEDGE_SELFBOT_RISK.');
  }
  const authWarnings = [];
  const botToken = readToken(env, ACCOUNTS.bot.variable, authWarnings);
  const userToken = mode === 'selfbot' ? readToken(env, ACCOUNTS.observer.variable, authWarnings) : null;
  if (userToken === botToken) throw new Error('DISCORD_BOT_TOKEN وARENA_USER_TOKEN متطابقان؛ يلزم توكن مستقل لكل حساب.');
  return { mode, botToken, userToken, authWarnings };
}

async function probeIdentity(token, role, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const { apiVersion } = ACCOUNTS[role];
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    // One read-only request to Discord itself. No retries, redirects or gateway login.
    response = await fetchImpl(`https://discord.com/api/v${apiVersion}/users/@me`, {
      method: 'GET', redirect: 'error', signal,
      headers: { Authorization: role === 'bot' ? `Bot ${token}` : token, Accept: 'application/json' }
    });
    const http = response.status;
    if (http === 200) {
      const identity = await response.json();
      if (typeof identity?.id !== 'string' || !/^\d{17,20}$/.test(identity.id)
        || (identity.bot !== undefined && typeof identity.bot !== 'boolean')) {
        return { code: 'UNEXPECTED_RESPONSE', http };
      }
      const isBot = identity.bot === true;
      return { code: isBot === (role === 'bot') ? 'REST_OK' : 'ACCOUNT_TYPE_MISMATCH', http };
    }
    const code = ({ 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 429: 'RATE_LIMITED' })[http]
      || (http >= 500 ? 'SERVER_ERROR' : 'UNEXPECTED_RESPONSE');
    return { code, http };
  } catch (error) {
    if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) return { code: 'TIMEOUT' };
    return { code: response?.status === 200 ? 'UNEXPECTED_RESPONSE' : 'NETWORK_ERROR' };
  } finally {
    if (response?.body && !response.bodyUsed) {
      try { await response.body.cancel(); } catch { /* Nothing from the response is logged. */ }
    }
  }
}

const DIAGNOSTIC_DETAILS = Object.freeze({
  REST_OK: 'قُبل التوكن لهذا الطلب ونوع الحساب مطابق. لا يثبت ذلك نجاح Gateway أو الوصول إلى السيرفر.',
  ACCOUNT_TYPE_MISMATCH: 'رد Discord بنوع حساب لا يطابق المتغير؛ تحقق من توزيع التوكنين.',
  UNAUTHORIZED: 'رفض Discord مصادقة هذا الطلب بالقيمة التي قرأتها العملية؛ لا تحدد النتيجة سبب الرفض.',
  FORBIDDEN: 'منع Discord الطلب. لم نصنف التوكن خطأ، ولن نعيد المحاولة أو نتجاوز المنع.',
  RATE_LIMITED: 'حد طلبات من Discord؛ أوقفنا الفحص دون إعادة محاولة.',
  SERVER_ERROR: 'خطأ خادم؛ لا يمكن الحكم على التوكن من هذه النتيجة.',
  NETWORK_ERROR: 'تعذر إكمال طلب الشبكة؛ لا يمكن الحكم على التوكن من هذه النتيجة.',
  TIMEOUT: 'انتهت مهلة الطلب؛ لا يمكن الحكم على التوكن من هذه النتيجة.',
  UNEXPECTED_RESPONSE: 'رد غير متوقع؛ لم تُطبع بيانات الرد ولا يمكن الجزم بصلاحية التوكن.'
});

async function runAuthDiagnostics(env = process.env, { log = console.log, fetchImpl = globalThis.fetch } = {}) {
  let config;
  try { config = readAuthConfig(env); }
  catch (error) { log(`[auth:config] ${error.message}`); return 1; }
  log('[diagnose] فحص مصادقة فقط: بلا MongoDB أو رسائل أو اتصال Gateway، وبلا طباعة توكنات أو بيانات حساب.');
  for (const warning of config.authWarnings) log(`[auth:config] ${warning}`);
  let exitCode = 0;
  const accounts = [['bot', config.botToken]];
  if (config.mode === 'selfbot') accounts.push(['observer', config.userToken]);
  for (const [role, token] of accounts) {
    const result = await probeIdentity(token, role, { fetchImpl });
    log(`[auth:${role}] ${ACCOUNTS[role].variable} ${result.code}${result.http ? ` HTTP ${result.http}` : ''}`);
    log(`[auth:${role}] ${DIAGNOSTIC_DETAILS[result.code]}`);
    if (result.code !== 'REST_OK') exitCode = 1;
    // A server/network block or rate limit is not a reason to send another request.
    if (['FORBIDDEN', 'RATE_LIMITED', 'SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT'].includes(result.code)) break;
  }
  log('[diagnose] انتهى الفحص. REST_OK مع فشل Gateway يعني قبول طلب REST ورفض اتصال Gateway؛ لا يثبت وحده عطل المكتبة.');
  return exitCode;
}


// Keep the instance available for Logs/Shell after one diagnostic pass.
// HTTP only reports diagnostic mode. It cannot rerun checks or expose results.
async function startDiagnosticServer({
  env = process.env, log = console.log, fetchImpl = globalThis.fetch,
  host = '0.0.0.0', port = Number(env.PORT || 10000)
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT_CONFIG_ERROR');
  }
  let finished = false;
  const server = createServer((request, response) => {
    const found = request.url === '/' || request.url === '/health';
    response.writeHead(found ? 200 : 404, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'
    });
    response.end(JSON.stringify(found
      ? { mode: 'diagnostic', botRunning: false, finished }
      : { error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    const failed = () => { server.off('listening', ready); reject(new Error('DIAGNOSTIC_PORT_ERROR')); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, host);
  });
  server.on('error', () => log('[diagnose] DIAGNOSTIC_SERVER_ERROR'));
  log('[diagnose] standalone-v1: ملف الفحص المستقل يعمل. البوت متوقف في هذا الوضع.');
  const done = runAuthDiagnostics(env, { log, fetchImpl }).then(result => {
    finished = true;
    log('[diagnose] RESULT=' + (result === 0 ? 'REST_CHECKS_PASSED' : 'CHECK_LOGS') + '. انسخ سطور [auth:] من Logs.');
    log('[diagnose] الفحص انتهى والخدمة باقية لعرض النتائج فقط. أمر تشغيل البوت المعتاد: npm start.');
    return result;
  }).catch(() => {
    finished = true;
    log('[diagnose] INTERNAL_ERROR: لم نطبع تفاصيل قد تحتوي بيانات حساسة. الخدمة باقية في وضع التشخيص.');
    return 1;
  });
  return { server, done };
}

module.exports = { readAuthConfig, probeIdentity, runAuthDiagnostics, startDiagnosticServer };

if (require.main === module) {
  startDiagnosticServer().then(({ server }) => {
    const stop = () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
      const deadline = setTimeout(() => process.exit(0), 2000);
      deadline.unref();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }).catch(() => {
    console.error('[diagnose] START_FAILED: تحقق من PORT وتوفر المنفذ. لم يبدأ فحص Discord.');
    process.exitCode = 1;
  });
}

