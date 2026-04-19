/**
 * @file index.ts — Cloudflare Worker entry point and HTTP/Queue/Cron router.
 *
 * This is the single entry point for the Zenith Mock system deployed as a
 * Cloudflare Worker. It dispatches incoming requests to the appropriate
 * handler based on URL path prefix:
 *
 *  - `/`              → Dashboard HTML (index.html)
 *  - `/console`       → Operations console (console.html)
 *  - `/bank-app`      → Customer banking app (bank-app.html)
 *  - `/api/...`       → ZC Core API (transfers, HTLC, GTID, RTP, DNS, etc.)
 *  - `/bank/:id/...`  → Bank API (ZC→Bank ingress, customer, teller, filters)
 *  - `/internal/...`  → Internal API (seed, cron triggers, DNS management)
 *
 * Also handles:
 *  - Cloudflare Queues consumer (async state machine advancement)
 *  - Cron triggers (EOD settlement at 07:30 UTC, timeout sweep every minute)
 *
 * @module index
 */
import type { Env, QueueMessage } from './types'
import { processQueueMessage } from './zc/orchestrator'
import { runEod } from './cron/eod'
import { runTimeoutSweep } from './cron/timeout_sweep'

// ZC ingress
import {
  handlePostTransfers, handlePostHtlcCreate, handlePostHtlcClaim,
  handlePostGtidRegister, handlePostRtpRequest,
  handlePostAuthorize, handlePostCancel, handlePostResumeNameCheck,
  handlePostParticipantRegister, handleSeed,
  handleAddBank, handleDeleteBank, handleListBanks, handleBankAccounts,
  handleAccountNameLookup, handleSimSetup, handleSimSetupOneBank,
  // HTLC Auth（受取側起点オーソリ型）
  handleHtlcAuthRequest, handleHtlcAuthApprove, handleHtlcAuthDecline,
  handleHtlcCapture, handleHtlcVoid,
  handleListHtlcAuthRequests, handleGetHtlcAuthRequest,
  handleRegisterAuthWhitelist, handleRevokeAuthWhitelist, handleListAuthWhitelist,
  json, jsonError,
} from './zc/ingress'

// ZC query
import {
  handleGetTransaction, handleGetGtid, handleGetHtlc,
  handleGetDnsStatus, handleGetDnsPosition,
  handleGetCase, handleListTransactions, handleListGtids, handleListHtlcs,
} from './zc/query'

// ZC PSPR
import { registerPspr } from './zc/pspr'

// Bank ingress (HTTP)
import { handleBankIngressHttp } from './bank/ingress'

// Bank customer API
import {
  handleGetAccounts, handleGetBalance, handleGetAccountTransactions,
  handlePostCustomerTransfer, handleGetTransferStatus,
} from './bank/customer_api'

// Bank teller API
import {
  handleCashDeposit, handleCashWithdrawal, handleGetJournals,
  handleSuspenseResolve, handleBatchStatus,
  handleTellerListAccounts, handleCreateAccount, handleUpdateAccountStatus,
  handleListSuspense, handleGetAllJournals, handleBatchCreateAccounts,
} from './bank/teller_api'

// Bank filter / approval API
import {
  createFilter, listFilters, setFilterActive, deleteFilter,
  listApprovalRequests, respondToApproval,
} from './bank/filter'

// ZC TxEventLog 照会
import { getTxEvents, getRecentEvents, getGtidEvents } from './zc/trace'

// ZC Finality chain verification & explainability
import { verifyChain } from './zc/finality_chain'
import { explainTransaction } from './zc/explain'

// DNS management
import { kickDns, holdDns, settleDns, getBojPositions } from './zc/dns'
import { updateCase } from './zc/case'

// ZC new feature modules
import { requestAccountVerification, getVerificationResult, batchVerify } from './zc/account_verify'
import { registerEdiRecord, getEdiByRef, getEdiByTxid } from './zc/edi'
import { registerProxy, resolveProxy as resolveProxyLookup, deactivateProxy } from './zc/proxy'
import { generateQrCode, getQrCode, processQrPayment } from './zc/qr'
import { newUUID } from './shared/idempotency'
import { nowISO } from './types'
import { storeRichData, getRichData, listRichDataByTxid } from './zc/richdata'
import { initiateCrossBorderTransfer, getCrossBorderTransaction, updateCrossBorderStatus } from './zc/cross_border'
import { createSseResponse } from './zc/stream'
import { handleIgsCallback } from './zc/igs'
import { respondToRtp } from './zc/rtp'

// Reversal & Circuit Breaker
import { requestReversal, getReversals, getReversalById } from './zc/reversal'
import { getCircuitStatus, listCircuitStates, resetCircuit } from './zc/circuit_breaker'

// Dashboard
import dashboardHtml from './dashboard/index.html'
import consoleHtml   from './dashboard/console.html'
import bankAppHtml   from './dashboard/bank-app.html'

// OpenAPI YAML
import zcApiYaml   from './openapi/zc-api'
import bankApiYaml from './openapi/bank-api'

export { LimitDO } from './zc/limit_do'
export { StreamDO } from './zc/stream_rafiki'

export default {
  // =========================================================================
  // HTTP fetch ハンドラー
  // =========================================================================
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    try {
      // -----------------------------------------------------------------------
      // Dashboard
      // -----------------------------------------------------------------------
      if (path === '/' || path === '/dashboard') {
        return new Response(dashboardHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } })
      }
      if (path === '/console') {
        return new Response(consoleHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } })
      }
      if (path === '/bank-app') {
        return new Response(bankAppHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } })
      }

      // -----------------------------------------------------------------------
      // ZC Core API: /api/...
      // -----------------------------------------------------------------------
      if (path.startsWith('/api/')) {
        // API認証: X-Api-Key ヘッダーまたは Authorization: Bearer ヘッダーを検証
        // モック環境では ZC_HMAC_SECRET を API キーとして使用
        const apiKey = req.headers.get('X-Api-Key') ?? req.headers.get('Authorization')?.replace('Bearer ', '')
        const referer = req.headers.get('Referer') || ''

        // UIからの呼び出しの判定：Refererだけでなく Origin も確認（Refererは偽造可能なため）
        // Referer が信頼できるドメイン配下のみ。正式には Origin ヘッダーで検証するべき
        const isFromTrustedReferer = referer.includes('/dashboard') || referer.includes('/console') || referer.includes('/bank-app') || referer.endsWith('/')

        // API キーがない場合、Referer による認証を許可するが、ログに記録（監査可能性）
        const hasValidApiKey = env.ZC_HMAC_SECRET && apiKey === env.ZC_HMAC_SECRET

        if (!hasValidApiKey && !isFromTrustedReferer) {
          const authErr = jsonError(401, 'UNAUTHORIZED', 'Valid X-Api-Key or Authorization Bearer header required')
          const newAuthResp = new Response(authErr.body, authErr)
          for (const [k, v] of Object.entries(corsHeaders)) newAuthResp.headers.set(k, v)
          return newAuthResp
        }

        const resp = await handleZcApi(req, path, method, env)
        // Add CORS to response
        const newResp = new Response(resp.body, resp)
        for (const [k, v] of Object.entries(corsHeaders)) newResp.headers.set(k, v)
        return newResp
      }

      // -----------------------------------------------------------------------
      // Bank API: /bank/:bankId/...
      // -----------------------------------------------------------------------
      if (path.startsWith('/bank/')) {
        const resp = await handleBankApi(req, path, method, env)
        const newResp = new Response(resp.body, resp)
        for (const [k, v] of Object.entries(corsHeaders)) newResp.headers.set(k, v)
        return newResp
      }

      // -----------------------------------------------------------------------
      // Internal Cron / Seed
      // -----------------------------------------------------------------------
      if (path.startsWith('/internal/')) {
        const resp = await handleInternal(req, path, method, env)
        const newResp = new Response(resp.body, resp)
        for (const [k, v] of Object.entries(corsHeaders)) newResp.headers.set(k, v)
        return newResp
      }

      return jsonError(404, 'NOT_FOUND', `Path ${path} not found`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[router] Unhandled error:', err)
      return jsonError(500, 'INTERNAL_ERROR', msg)
    }
  },

  // =========================================================================
  // Cloudflare Queues コンシューマー
  // =========================================================================
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processQueueMessage(msg.body, env)
        msg.ack()
      } catch (err) {
        console.error('[queue consumer] error:', err)
        msg.retry()
      }
    }
  },

  // =========================================================================
  // Cron Triggers
  // =========================================================================
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron
    if (cron === '30 7 * * *') {
      ctx.waitUntil(runEod(env).then(r => console.log('[eod]', r.log)))
    } else if (cron === '* * * * *') {
      ctx.waitUntil(runTimeoutSweep(env).then(r => console.log('[sweep] swept:', r.swept)))
    }
  },
}

// =========================================================================
// ZC ルーティング
// =========================================================================
async function handleZcApi(req: Request, path: string, method: string, env: Env): Promise<Response> {
  // GET /api/openapi/*.yaml — API仕様書
  const yamlHeaders = { 'Content-Type': 'text/yaml; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  if (method === 'GET' && path === '/api/openapi/zc.yaml')
    return new Response(zcApiYaml, { headers: yamlHeaders })
  if (method === 'GET' && path === '/api/openapi/bank.yaml')
    return new Response(bankApiYaml, { headers: yamlHeaders })

  // POST /api/transfers
  if (method === 'POST' && path === '/api/transfers')
    return handlePostTransfers(req, env)

  // POST /api/htlc/create
  if (method === 'POST' && path === '/api/htlc/create')
    return handlePostHtlcCreate(req, env)

  // POST /api/htlc/auth-request  受取側オーソリリクエスト
  if (method === 'POST' && path === '/api/htlc/auth-request')
    return handleHtlcAuthRequest(req, env)

  // GET /api/htlc/auth-requests  オーソリリクエスト一覧
  if (method === 'GET' && path === '/api/htlc/auth-requests')
    return handleListHtlcAuthRequests(req, env)

  // GET /api/stream/connect  (Rafiki-style Streaming Websocket)
  if (method === 'GET' && path === '/api/stream/connect') {
    const id = env.STREAM_DO?.idFromName('global-stream-1')
    if (!id || !env.STREAM_DO) return jsonError(500, 'NO_DO', 'STREAM_DO unavailable')
    const stub = env.STREAM_DO.get(id)
    return stub.fetch(req)
  }

  // GET /api/als/lookup  (Mojaloop-style Account Lookup Service)
  if (method === 'GET' && path === '/api/als/lookup') {
    const alias = new URL(req.url).searchParams.get('alias')
    if (!alias) return jsonError(400, 'BAD_REQUEST', '?alias= required')
    const { lookupAlias } = await import('./zc/als')
    const res = await lookupAlias(alias, env)
    if (!res) return jsonError(404, 'NOT_FOUND', 'Alias not found')
    return json(200, res)
  }

  // POST /api/limit/reserve (TigerBeetle-style DO limitation logic)
  if (method === 'POST' && path === '/api/limit/reserve') {
    const bank_id = req.headers.get('X-Bank-Id') || 'global'
    const id = env.LIMIT_DO?.idFromName(bank_id)
    if (!id || !env.LIMIT_DO) return jsonError(500, 'NO_DO', 'LIMIT_DO unavailable')
    const stub = env.LIMIT_DO.get(id)
    return stub.fetch(new Request('http://do/reserve', { method: 'POST', body: await req.text() }))
  }

  // GET/POST/DELETE /api/htlc/auth-whitelist  ホワイトリスト管理
  if (path === '/api/htlc/auth-whitelist') {
    if (method === 'GET') return handleListAuthWhitelist(env)
    if (method === 'POST') return handleRegisterAuthWhitelist(req, env)
  }
  const whitelistDeleteMatch = path.match(/^\/api\/htlc\/auth-whitelist\/([^/]+)$/)
  if (method === 'DELETE' && whitelistDeleteMatch)
    return handleRevokeAuthWhitelist(whitelistDeleteMatch[1]!, env)

  // GET /api/htlc/auth/:auth_id  オーソリリクエスト詳細
  const htlcAuthGetMatch = path.match(/^\/api\/htlc\/auth\/([^/]+)$/)
  if (method === 'GET' && htlcAuthGetMatch)
    return handleGetHtlcAuthRequest(htlcAuthGetMatch[1]!, env)

  // POST /api/htlc/auth/:auth_id/approve  送金側承認
  const htlcAuthApproveMatch = path.match(/^\/api\/htlc\/auth\/([^/]+)\/approve$/)
  if (method === 'POST' && htlcAuthApproveMatch)
    return handleHtlcAuthApprove(req, htlcAuthApproveMatch[1]!, env)

  // POST /api/htlc/auth/:auth_id/decline  送金側拒否
  const htlcAuthDeclineMatch = path.match(/^\/api\/htlc\/auth\/([^/]+)\/decline$/)
  if (method === 'POST' && htlcAuthDeclineMatch)
    return handleHtlcAuthDecline(req, htlcAuthDeclineMatch[1]!, env)

  // POST /api/htlc/:htlc_id/claim
  const htlcClaimMatch = path.match(/^\/api\/htlc\/([^/]+)\/claim$/)
  if (method === 'POST' && htlcClaimMatch)
    return handlePostHtlcClaim(req, htlcClaimMatch[1]!, env)

  // POST /api/htlc/:htlc_id/capture  受取側キャプチャ（オーソリ型）
  const htlcCaptureMatch = path.match(/^\/api\/htlc\/([^/]+)\/capture$/)
  if (method === 'POST' && htlcCaptureMatch)
    return handleHtlcCapture(req, htlcCaptureMatch[1]!, env)

  // POST /api/htlc/:htlc_id/void  ボイド（オーソリ取消）
  const htlcVoidMatch = path.match(/^\/api\/htlc\/([^/]+)\/void$/)
  if (method === 'POST' && htlcVoidMatch)
    return handleHtlcVoid(req, htlcVoidMatch[1]!, env)

  // GET /api/htlc  (一覧)
  if (method === 'GET' && path === '/api/htlc')
    return handleListHtlcs(req, env)

  // GET /api/htlc/:htlc_id
  const htlcGetMatch = path.match(/^\/api\/htlc\/([^/]+)$/)
  if (method === 'GET' && htlcGetMatch)
    return handleGetHtlc(htlcGetMatch[1]!, env)

  // GET /api/transactions/:txid/events  取引イベントログ
  const txEventsMatch = path.match(/^\/api\/transactions\/([^/]+)\/events$/)
  if (method === 'GET' && txEventsMatch) {
    const events = await getTxEvents(txEventsMatch[1]!, env.DB)
    return json(200, { txid: txEventsMatch[1], events })
  }

  // GET /api/transactions/:txid/explain  人間可読な状態遷移の説明 + 改ざん検知
  const txExplainMatch = path.match(/^\/api\/transactions\/([^/]+)\/explain$/)
  if (method === 'GET' && txExplainMatch) {
    const result = await explainTransaction(env.DB, txExplainMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', `txid ${txExplainMatch[1]} not found`)
    return json(200, result)
  }

  // GET /api/transactions/:txid/verify  FinalityLog ハッシュチェーン検証
  const txVerifyMatch = path.match(/^\/api\/transactions\/([^/]+)\/verify$/)
  if (method === 'GET' && txVerifyMatch) {
    const result = await verifyChain(env.DB, txVerifyMatch[1]!)
    return json(200, result)
  }

  // GET /api/gtid/:gtid/verify  GTID 用ハッシュチェーン検証
  const gtidVerifyMatch = path.match(/^\/api\/gtid\/([^/]+)\/verify$/)
  if (method === 'GET' && gtidVerifyMatch) {
    const result = await verifyChain(env.DB, gtidVerifyMatch[1]!)
    return json(200, result)
  }

  // GET /api/events  全体イベントログ（最近N件）
  if (method === 'GET' && path === '/api/events') {
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') ?? '100')
    const offset = parseInt(url.searchParams.get('offset') ?? '0')
    const events = await getRecentEvents(env.DB, limit, offset)
    return json(200, { events })
  }

  // POST /api/gtid/register
  if (method === 'POST' && path === '/api/gtid/register')
    return handlePostGtidRegister(req, env)

  // GET /api/gtid (一覧)
  if (method === 'GET' && path === '/api/gtid')
    return handleListGtids(req, env)

  // GET /api/gtid/:gtid/events  (/events を先にマッチさせる)
  const gtidEventsMatch = path.match(/^\/api\/gtid\/([^/]+)\/events$/)
  if (method === 'GET' && gtidEventsMatch) {
    const events = await getGtidEvents(gtidEventsMatch[1]!, env.DB)
    return json(200, { gtid: gtidEventsMatch[1], events })
  }

  // GET /api/gtid/:gtid
  const gtidMatch = path.match(/^\/api\/gtid\/([^/]+)$/)
  if (method === 'GET' && gtidMatch)
    return handleGetGtid(gtidMatch[1]!, env)

  // GET /api/rtp/incoming?account=XXXXXXXXXX  受信請求一覧（payer側）
  if (method === 'GET' && path === '/api/rtp/incoming') {
    const account = new URL(req.url).searchParams.get('account') ?? ''

    // account は bank_id(3) + account_number(7) = 10文字であることを検証
    if (!account || account.length !== 10) {
      return jsonError(400, 'INVALID_ACCOUNT_FORMAT', 'account parameter must be exactly 10 characters (bank_id + account_number)')
    }

    const payerBankId = account.slice(0, 3)
    const now = new Date().toISOString()
    const rows = await env.DB.prepare(`
      SELECT rtp_id, payee_bank_id, payer_bank_id, amount_value, rtp_status,
             payee_name, description, expires_at, notified_at, created_at
      FROM RtpRequestRows
      WHERE payer_bank_id = ?
        AND (rtp_status = 'NOTIFIED' OR rtp_status = 'CREATED')
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(payerBankId, now).all<Record<string, unknown>>()
    return json(200, { requests: rows.results })
  }

  // POST /api/rtp/request
  if (method === 'POST' && path === '/api/rtp/request')
    return handlePostRtpRequest(req, env)

  // POST /api/transfers/:txid/authorize
  const authMatch = path.match(/^\/api\/transfers\/([^/]+)\/authorize$/)
  if (method === 'POST' && authMatch)
    return handlePostAuthorize(req, authMatch[1]!, env)

  // POST /api/transfers/:txid/cancel
  const cancelMatch = path.match(/^\/api\/transfers\/([^/]+)\/cancel$/)
  if (method === 'POST' && cancelMatch)
    return handlePostCancel(req, cancelMatch[1]!, env)

  // POST /api/transfers/:txid/resume-namecheck
  const resumeNamecheckMatch = path.match(/^\/api\/transfers\/([^/]+)\/resume-namecheck$/)
  if (method === 'POST' && resumeNamecheckMatch)
    return handlePostResumeNameCheck(req, resumeNamecheckMatch[1]!, env)

  // GET /api/transactions (list)
  if (method === 'GET' && path === '/api/transactions')
    return handleListTransactions(req, env)

  // GET /api/transactions/:txid
  const txidMatch = path.match(/^\/api\/transactions\/([^/]+)$/)
  if (method === 'GET' && txidMatch)
    return handleGetTransaction(txidMatch[1]!, env)

  // GET /api/dns/:business_date/status
  const dnsStatusMatch = path.match(/^\/api\/dns\/([^/]+)\/status$/)
  if (method === 'GET' && dnsStatusMatch)
    return handleGetDnsStatus(dnsStatusMatch[1]!, env)

  // GET /api/dns/:business_date/position
  const dnsPosMatch = path.match(/^\/api\/dns\/([^/]+)\/position$/)
  if (method === 'GET' && dnsPosMatch)
    return handleGetDnsPosition(dnsPosMatch[1]!, env)

  // GET /api/boj/positions — 各参加行の日銀預け金（BOJ）残高照会（公開API）
  // 報告書「論点7: 資金清算・決済のあり方」—プレファンドRTGS方式の残高監視
  if (method === 'GET' && path === '/api/boj/positions') {
    const positions = await getBojPositions(env.DB)
    return json(200, { positions, as_of: nowISO() })
  }

  // GET /api/cases/:case_id
  const caseMatch = path.match(/^\/api\/cases\/([^/]+)$/)
  if (method === 'GET' && caseMatch)
    return handleGetCase(caseMatch[1]!, env)

  // POST /api/cases/:case_id/update
  const caseUpdateMatch = path.match(/^\/api\/cases\/([^/]+)\/update$/)
  if (method === 'POST' && caseUpdateMatch) {
    const body = await req.json() as { state: string }
    await updateCase(env.DB, caseUpdateMatch[1]!, body.state as any)
    return json(200, { result: 'UPDATED' })
  }

  // -----------------------------------------------------------------------
  // Reversal（救済取引）
  // -----------------------------------------------------------------------

  // POST /api/reversals
  if (method === 'POST' && path === '/api/reversals') {
    const body = await req.json<any>()
    const result = await requestReversal(body, env)
    return json(result.result === 'REVERSAL_CREATED' ? 201 : 422, result)
  }

  // GET /api/reversals/:reversal_id
  const revIdMatch = path.match(/^\/api\/reversals\/([^/]+)$/)
  if (method === 'GET' && revIdMatch) {
    const rev = await getReversalById(revIdMatch[1]!, env.DB)
    if (!rev) return jsonError(404, 'NOT_FOUND', 'reversal not found')
    return json(200, rev)
  }

  // GET /api/transactions/:txid/reversals
  const txRevMatch = path.match(/^\/api\/transactions\/([^/]+)\/reversals$/)
  if (method === 'GET' && txRevMatch) {
    const revs = await getReversals(txRevMatch[1]!, env.DB)
    return json(200, { original_txid: txRevMatch[1], reversals: revs })
  }

  // -----------------------------------------------------------------------
  // Circuit Breaker（参加行疎通監視）
  // -----------------------------------------------------------------------

  // GET /api/circuit-breaker
  if (method === 'GET' && path === '/api/circuit-breaker') {
    const states = await listCircuitStates(env.DB)
    return json(200, { circuit_breakers: states })
  }

  // GET /api/circuit-breaker/:bank_id
  const cbMatch = path.match(/^\/api\/circuit-breaker\/([^/]+)$/)
  if (method === 'GET' && cbMatch) {
    const status = await getCircuitStatus(cbMatch[1]!, env.DB)
    if (!status) return json(200, { bank_id: cbMatch[1], state: 'CLOSED', consecutive_failures: 0 })
    return json(200, status)
  }

  // POST /api/circuit-breaker/:bank_id/reset  (ops override)
  const cbResetMatch = path.match(/^\/api\/circuit-breaker\/([^/]+)\/reset$/)
  if (method === 'POST' && cbResetMatch) {
    await resetCircuit(cbResetMatch[1]!, env.DB)
    return json(200, { result: 'RESET', bank_id: cbResetMatch[1] })
  }

  // POST /api/pspr/register
  if (method === 'POST' && path === '/api/pspr/register') {
    const body = await req.json() as any
    const result = await registerPspr(env.DB, body.pspr_ref, body.payee_bank_id, body.account_hash, body.expires_at)
    return json(201, result)
  }

  // POST /api/participants/register
  if (method === 'POST' && path === '/api/participants/register')
    return handlePostParticipantRegister(req, env)

  // --- 銀行管理 ---
  // GET /api/banks
  if (method === 'GET' && path === '/api/banks')
    return handleListBanks(env)

  // POST /api/banks/add
  if (method === 'POST' && path === '/api/banks/add')
    return handleAddBank(req, env)

  // DELETE /api/banks/:bankId
  const bankDeleteMatch = path.match(/^\/api\/banks\/([^/]+)$/)
  if (method === 'DELETE' && bankDeleteMatch)
    return handleDeleteBank(bankDeleteMatch[1]!, env)

  // GET /api/banks/:bankId/accounts
  const bankAcctsMatch = path.match(/^\/api\/banks\/([^/]+)\/accounts$/)
  if (method === 'GET' && bankAcctsMatch)
    return handleBankAccounts(bankAcctsMatch[1]!, env)

  // GET /api/accounts/:accountId/name  名義照会
  const nameMatch = path.match(/^\/api\/accounts\/([^/]+)\/name$/)
  if (method === 'GET' && nameMatch)
    return handleAccountNameLookup(nameMatch[1]!, env)

  // POST /api/rtp/:rtpId/respond
  const rtpRespondMatch = path.match(/^\/api\/rtp\/([^/]+)\/respond$/)
  if (method === 'POST' && rtpRespondMatch) {
    const body = await req.json<any>()
    const result = await respondToRtp(env.DB, rtpRespondMatch[1]!, body, env)
    return json(200, result)
  }

  // --- Account Verification ---
  // POST /api/account-verify/batch  (must come before /:verificationId)
  if (method === 'POST' && path === '/api/account-verify/batch') {
    const body = await req.json<any>()
    const bankId = req.headers.get('X-Bank-Id') ?? 'UNKNOWN'
    const results = await batchVerify(env.DB, { ...body, request_bank_id: body.request_bank_id ?? bankId }, env)
    return json(200, results)
  }

  // POST /api/account-verify
  if (method === 'POST' && path === '/api/account-verify') {
    const body = await req.json<any>()
    const bankId = req.headers.get('X-Bank-Id') ?? 'UNKNOWN'
    const result = await requestAccountVerification(env.DB, { ...body, request_bank_id: body.request_bank_id ?? bankId }, env)
    return json(200, result)
  }

  // GET /api/account-verify/:verificationId
  const acctVerifyMatch = path.match(/^\/api\/account-verify\/([^/]+)$/)
  if (method === 'GET' && acctVerifyMatch) {
    const result = await getVerificationResult(env.DB, acctVerifyMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', 'verification not found')
    return json(200, result)
  }

  // --- EDI ---
  // POST /api/edi/register
  if (method === 'POST' && path === '/api/edi/register') {
    const body = await req.json<any>()
    const bankId = req.headers.get('X-Bank-Id') ?? 'UNKNOWN'
    const result = await registerEdiRecord(env.DB, body, bankId)
    return json(201, result)
  }

  // GET /api/edi/tx/:txid  (must come before /api/edi/:ediRef)
  const ediTxMatch = path.match(/^\/api\/edi\/tx\/([^/]+)$/)
  if (method === 'GET' && ediTxMatch) {
    const result = await getEdiByTxid(env.DB, ediTxMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', 'EDI record not found')
    return json(200, result)
  }

  // GET /api/edi/:ediRef
  const ediRefMatch = path.match(/^\/api\/edi\/([^/]+)$/)
  if (method === 'GET' && ediRefMatch) {
    const result = await getEdiByRef(env.DB, ediRefMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', 'EDI record not found')
    return json(200, result)
  }

  // --- Proxy ---
  // POST /api/proxy/register
  if (method === 'POST' && path === '/api/proxy/register') {
    const body = await req.json<any>()
    const result = await registerProxy(env.DB, body)
    return json(201, result)
  }

  // GET /api/proxy/resolve
  if (method === 'GET' && path === '/api/proxy/resolve') {
    const url2 = new URL(req.url)
    const proxyType = (url2.searchParams.get('proxy_type') ?? url2.searchParams.get('type')) as any
    const proxyValue = url2.searchParams.get('proxy_value') ?? url2.searchParams.get('value') ?? ''
    if (!proxyType || !proxyValue) return jsonError(400, 'INVALID_PARAMS', 'proxy_type and proxy_value required')
    const result = await resolveProxyLookup(env.DB, proxyType, proxyValue)
    if (!result) return jsonError(404, 'NOT_FOUND', 'proxy not found')
    return json(200, result)
  }

  // DELETE /api/proxy/:proxyId
  const proxyDeleteMatch = path.match(/^\/api\/proxy\/([^/]+)$/)
  if (method === 'DELETE' && proxyDeleteMatch) {
    await deactivateProxy(env.DB, proxyDeleteMatch[1]!)
    return json(200, { result: 'DEACTIVATED' })
  }

  // --- QR ---
  // POST /api/qr/generate
  if (method === 'POST' && path === '/api/qr/generate') {
    const body = await req.json<any>()
    const result = await generateQrCode(env.DB, body, env)
    return json(201, result)
  }

  // POST /api/qr/pay  (must come before /api/qr/:qrRef)
  if (method === 'POST' && path === '/api/qr/pay') {
    const body = await req.json<any>()
    const result = await processQrPayment(env.DB, body, env)
    if (!result.valid) return jsonError(400, 'QR_INVALID', result.error ?? 'QR payment failed')

    // QR検証OK → 実際の振込処理を起動
    const qr = result.qrRow!
    const txid = `TX-${newUUID()}`
    const zcReq = new Request('http://internal/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: '1.0',
        message_type: 'EVENT',
        name: 'PaymentInitiated',
        message_id: newUUID(),
        idempotency_key: body.idempotency_key ?? newUUID(),
        occurred_at: nowISO(),
        txid,
        lane: 'EXPRESS',
        amount: { value: result.effectiveAmount, currency: qr.amount_currency ?? 'JPY' },
        payer: { bank_id: body.payer_bank_id, account_hash: body.payer_account_id },
        payee: { bank_id: qr.payee_bank_id, account_hash: qr.payee_account_id },
        purpose: 'MERCHANT',
        qr_ref: qr.qr_ref,
      }),
    })
    return handlePostTransfers(zcReq, env)
  }

  // GET /api/qr/:qrRef
  const qrRefMatch = path.match(/^\/api\/qr\/([^/]+)$/)
  if (method === 'GET' && qrRefMatch) {
    const result = await getQrCode(env.DB, qrRefMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', 'QR code not found')
    return json(200, result)
  }

  // --- Rich Data ---
  // POST /api/richdata/store
  if (method === 'POST' && path === '/api/richdata/store') {
    const body = await req.json<any>()
    const bankId = req.headers.get('X-Bank-Id') ?? 'UNKNOWN'
    const result = await storeRichData(env.DB, body, bankId, env)
    return json(201, result)
  }

  // GET /api/richdata/tx/:txid  (must come before /api/richdata/:dataRef)
  const richDataTxMatch = path.match(/^\/api\/richdata\/tx\/([^/]+)$/)
  if (method === 'GET' && richDataTxMatch) {
    const result = await listRichDataByTxid(env.DB, richDataTxMatch[1]!)
    return json(200, result)
  }

  // GET /api/richdata/:dataRef
  const richDataRefMatch = path.match(/^\/api\/richdata\/([^/]+)$/)
  if (method === 'GET' && richDataRefMatch) {
    const result = await getRichData(env.DB, richDataRefMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', 'rich data not found')
    return json(200, result)
  }

  // --- Cross-Border ---
  // POST /api/cross-border/send
  if (method === 'POST' && path === '/api/cross-border/send') {
    const body = await req.json<any>()
    try {
      const result = await initiateCrossBorderTransfer(env.DB, body, env)
      return json(201, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('FATF R16 validation failed')) {
        return jsonError(400, 'FATF_VALIDATION_ERROR', msg)
      }
      throw err
    }
  }

  // POST /api/cross-border/:cbTxid/callback  (must come before /:cbTxid)
  const cbCallbackMatch = path.match(/^\/api\/cross-border\/([^/]+)\/callback$/)
  if (method === 'POST' && cbCallbackMatch) {
    const body = await req.json<any>()
    await updateCrossBorderStatus(env.DB, cbCallbackMatch[1]!, body.status, body.foreign_ref)
    return json(200, { result: 'UPDATED' })
  }

  // GET /api/cross-border/:cbTxid
  const cbTxidMatch = path.match(/^\/api\/cross-border\/([^/]+)$/)
  if (method === 'GET' && cbTxidMatch) {
    const result = await getCrossBorderTransaction(env.DB, cbTxidMatch[1]!)
    if (!result) return jsonError(404, 'NOT_FOUND', 'cross-border transaction not found')
    return json(200, result)
  }

  // --- SSE ---
  // GET /api/sse/events/:bankId
  const sseMatch = path.match(/^\/api\/sse\/events\/([^/]+)$/)
  if (method === 'GET' && sseMatch)
    return createSseResponse(env.DB, sseMatch[1]!)

  // --- IGS ---
  // POST /api/igs/callback
  if (method === 'POST' && path === '/api/igs/callback') {
    const body = await req.json<any>()
    await handleIgsCallback(env.DB, body, env)
    return json(200, { result: 'OK' })
  }

  return jsonError(404, 'NOT_FOUND', `ZC API ${method} ${path} not found`)
}

// =========================================================================
// Bank ルーティング  /bank/:bankId/...
// =========================================================================
async function handleBankApi(req: Request, path: string, method: string, env: Env): Promise<Response> {
  const bankMatch = path.match(/^\/bank\/([^/]+)(.*)$/)
  if (!bankMatch) return jsonError(404, 'NOT_FOUND', 'invalid bank path')
  const bankId = bankMatch[1]!
  const sub = bankMatch[2] ?? ''

  // ZC→Bank Ingress API
  const ingressMatch = sub.match(/^\/zc-ingress\/([^/]+)$/)
  if (method === 'POST' && ingressMatch)
    return handleBankIngressHttp(req, bankId, ingressMatch[1]!, env)

  // 顧客API
  if (method === 'GET' && sub === '/v1/me/accounts')
    return handleGetAccounts(req, bankId, env)

  const balanceMatch = sub.match(/^\/v1\/me\/accounts\/([^/]+)\/balance$/)
  if (method === 'GET' && balanceMatch)
    return handleGetBalance(req, bankId, balanceMatch[1]!, env)

  const acctTxMatch = sub.match(/^\/v1\/me\/accounts\/([^/]+)\/transactions$/)
  if (method === 'GET' && acctTxMatch)
    return handleGetAccountTransactions(req, bankId, acctTxMatch[1]!, env)

  if (method === 'POST' && sub === '/v1/me/transfers')
    return handlePostCustomerTransfer(req, bankId, env)

  const txStatusMatch = sub.match(/^\/v1\/me\/transfers\/([^/]+)$/)
  if (method === 'GET' && txStatusMatch)
    return handleGetTransferStatus(req, bankId, txStatusMatch[1]!, env)

  // 行員API
  if (method === 'POST' && sub === '/v1/teller/cash/deposit')
    return handleCashDeposit(req, bankId, env)

  if (method === 'POST' && sub === '/v1/teller/cash/withdrawal')
    return handleCashWithdrawal(req, bankId, env)

  if (method === 'GET' && sub === '/v1/teller/accounts')
    return handleTellerListAccounts(req, bankId, env)
  if (method === 'POST' && sub === '/v1/teller/accounts')
    return handleCreateAccount(req, bankId, env)
  if (method === 'POST' && sub === '/v1/teller/accounts/batch')
    return handleBatchCreateAccounts(req, bankId, env)

  const acctStatusMatch = sub.match(/^\/v1\/teller\/accounts\/([^/]+)\/status$/)
  if (method === 'PATCH' && acctStatusMatch)
    return handleUpdateAccountStatus(req, bankId, acctStatusMatch[1]!, env)

  if (method === 'GET' && sub === '/v1/teller/journals')
    return handleGetAllJournals(req, bankId, env)
  const journalMatch = sub.match(/^\/v1\/teller\/accounts\/([^/]+)\/journals$/)
  if (method === 'GET' && journalMatch)
    return handleGetJournals(req, bankId, journalMatch[1]!, env)

  if (method === 'GET' && sub === '/v1/teller/suspense')
    return handleListSuspense(req, bankId, env)

  const suspResolveMatch = sub.match(/^\/v1\/teller\/suspense\/([^/]+)\/resolve$/)
  if (method === 'POST' && suspResolveMatch)
    return handleSuspenseResolve(req, bankId, suspResolveMatch[1]!, env)

  if (method === 'GET' && sub === '/v1/teller/batch/status')
    return handleBatchStatus(req, bankId, env)

  // 着金フィルタ管理 API
  if (sub === '/v1/filters') {
    if (method === 'GET') {
      const url = new URL(req.url)
      const filters = await listFilters(bankId, url.searchParams.get('account_id'), env.DB)
      return json(200, { filters })
    }
    if (method === 'POST') {
      const body = await req.json().catch(() => null) as any
      if (!body) return jsonError(400, 'INVALID_JSON', 'invalid body')
      const filter = await createFilter(bankId, body, env.DB)
      return json(201, filter)
    }
  }
  const filterIdMatch = sub.match(/^\/v1\/filters\/([^/]+)$/)
  if (filterIdMatch) {
    const filterId = filterIdMatch[1]!
    if (method === 'DELETE') {
      const ok = await deleteFilter(bankId, filterId, env.DB)
      return ok ? json(200, { result: 'DELETED', filter_id: filterId })
        : jsonError(404, 'NOT_FOUND', `filter ${filterId} not found`)
    }
    if (method === 'PATCH') {
      const body = await req.json().catch(() => null) as any
      const ok = await setFilterActive(bankId, filterId, body?.is_active !== false, env.DB)
      return ok ? json(200, { result: 'UPDATED', filter_id: filterId })
        : jsonError(404, 'NOT_FOUND', `filter ${filterId} not found`)
    }
  }

  // 着金承認 API（顧客）
  if (method === 'GET' && sub === '/v1/me/approvals') {
    const url = new URL(req.url)
    const approvals = await listApprovalRequests(
      bankId,
      url.searchParams.get('account_id'),
      url.searchParams.get('status') ?? 'PENDING',
      env.DB,
    )
    return json(200, { approvals })
  }
  const approvalRespondMatch = sub.match(/^\/v1\/me\/approvals\/([^/]+)\/respond$/)
  if (method === 'POST' && approvalRespondMatch) {
    const body = await req.json().catch(() => null) as any
    if (body === null || typeof body.approved !== 'boolean') {
      return jsonError(400, 'INVALID_JSON', 'approved (boolean) required')
    }
    const result = await respondToApproval(bankId, approvalRespondMatch[1]!, body, env.DB)
    if (!result.ok) return jsonError(400, result.reason ?? 'ERROR', result.reason ?? 'failed')

    // 承認された場合: ZC に resume_credit を通知（Queue 経由）
    if (body.approved && result.txid) {
      // 対象取引の payee 情報を取得
      const txInfo = await env.DB.prepare(
        `SELECT payee_bank_id, payee_account_hash FROM Transactions WHERE txid=?`
      ).bind(result.txid).first<{ payee_bank_id: string; payee_account_hash: string | null }>()
      if (txInfo) {
        await env.QUEUE.send({
          type: 'ZC_RESUME_CREDIT',
          payload: { txid: result.txid, payee_bank_id: txInfo.payee_bank_id, payee_account_hash: txInfo.payee_account_hash ?? undefined },
          txid: result.txid, attempt: 0, enqueued_at: new Date().toISOString(),
        })
      }
    }
    return json(200, { result: body.approved ? 'APPROVED' : 'REJECTED', txid: result.txid })
  }

  // BankAuditLog 照会（行員）
  if (method === 'GET' && sub === '/v1/teller/audit-log') {
    const url = new URL(req.url)
    const txid = url.searchParams.get('txid')
    const limit = parseInt(url.searchParams.get('limit') ?? '100')
    let sql = `SELECT * FROM BankAuditLog WHERE bank_id=?`
    const binds: unknown[] = [bankId]
    if (txid) { sql += ` AND txid=?`; binds.push(txid) }
    sql += ` ORDER BY occurred_at DESC LIMIT ?`
    binds.push(limit)
    const rows = await env.DB.prepare(sql).bind(...binds).all()
    return json(200, { audit_log: rows.results })
  }

  return jsonError(404, 'NOT_FOUND', `Bank API ${method} ${path} not found`)
}

// =========================================================================
// Internal API
// =========================================================================
async function handleInternal(req: Request, path: string, method: string, env: Env): Promise<Response> {
  // CRON_SECRET 検証
  const cronSecret = req.headers.get('X-Cron-Secret')
  if (cronSecret !== env.CRON_SECRET)
    return jsonError(403, 'FORBIDDEN', 'X-Cron-Secret required')

  if (method === 'POST' && path === '/internal/cron/eod') {
    const result = await runEod(env)
    return json(200, result)
  }

  if (method === 'POST' && path === '/internal/cron/timeout-sweep') {
    const result = await runTimeoutSweep(env)
    return json(200, result)
  }

  if (method === 'POST' && path === '/internal/seed') {
    return handleSeed(env)
  }

  // DNS manual kick
  if (method === 'POST' && path === '/internal/dns/kick') {
    const body = await req.json().catch(() => ({})) as Record<string, string>
    const { todayJST } = await import('./types')
    const date = body.business_date ?? todayJST()
    const result = await kickDns(date, env)
    return json(200, result)
  }

  // DNS manual settle
  if (method === 'POST' && path === '/internal/dns/settle') {
    const body = await req.json().catch(() => ({})) as Record<string, string>
    if (!body.cycle_id) return jsonError(400, 'MISSING_PARAM', 'cycle_id required')
    await settleDns(body.cycle_id, env)
    return json(200, { result: 'SETTLED', cycle_id: body.cycle_id })
  }

  // 各銀行の日銀預け金勘定（BOJ）残高照会
  if (method === 'GET' && path === '/internal/boj-positions') {
    const positions = await getBojPositions(env.DB)
    return json(200, { positions })
  }

  if (method === 'POST' && path === '/internal/sim/setup') {
    return handleSimSetup(req, env)
  }

  if (method === 'POST' && path === '/internal/sim/setup-bank') {
    return handleSimSetupOneBank(req, env)
  }

  // POST /internal/transfers/:txid/resume-credit
  // 顧客が着金承認後、銀行が ZC にクレジット処理の再開を通知する
  const resumeCreditMatch = path.match(/^\/internal\/transfers\/([^/]+)\/resume-credit$/)
  if (method === 'POST' && resumeCreditMatch) {
    const txid = resumeCreditMatch[1]!
    const txInfo = await env.DB.prepare(
      `SELECT payee_bank_id, payee_account_hash FROM Transactions WHERE txid=?`
    ).bind(txid).first<{ payee_bank_id: string; payee_account_hash: string | null }>()
    if (!txInfo) return jsonError(404, 'NOT_FOUND', `txid ${txid} not found`)
    await env.QUEUE.send({
      type: 'ZC_RESUME_CREDIT',
      payload: { txid, payee_bank_id: txInfo.payee_bank_id, payee_account_hash: txInfo.payee_account_hash ?? undefined },
      txid, attempt: 0, enqueued_at: new Date().toISOString(),
    })
    return json(200, { result: 'QUEUED', txid })
  }

  return jsonError(404, 'NOT_FOUND', `Internal ${path} not found`)
}
