const API = 'http://127.0.0.1:3333/api'
const $ = (id) => document.getElementById(id)
let token = '',
  activeAccountId = 0,
  availableAccounts = []
let instanceId = ''
let loadAccountsSeq = 0,
  loadQueueSeq = 0,
  openingJob = false
let capacity = null,
  capacityDeadline = 0,
  capacitySeq = 0,
  capacityInputAccount = 0,
  capacityBusy = false,
  canManageCapacity = false
async function request(path, options = {}) {
  const send = () =>
    fetch(API + path, {
      ...options,
      signal: options.signal || AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        ...options.headers,
      },
    })
  let response = await send()
  if (response.status === 401 && path !== '/auth/login') {
    const renewed = await chrome.runtime.sendMessage({ type: 'AUTOFLOW_REFRESH_SESSION' })
    if (renewed?.ok && renewed.token) {
      token = renewed.token
      response = await send()
    }
  }
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Resposta inválida (HTTP ${response.status})`)
  }
  if (!response.ok) throw new Error(data.error || `Falha (HTTP ${response.status})`)
  return data
}
function setConnected(connected, user) {
  $('loginView').hidden = connected
  $('queueView').hidden = !connected
  $('apiState').className = connected ? 'online' : ''
  if (user) {
    $('userName').textContent = user.name
    canManageCapacity = user.role === 'admin'
  }
  if (!connected) {
    capacitySeq++
    capacity = null
    capacityInputAccount = 0
  }
  $('capacitySettings').hidden = !connected || !canManageCapacity
}
function statusLabel(status) {
  return (
    {
      pending: 'Pendente',
      filling: 'Preenchendo',
      error: 'Revisar erro',
      awaiting_confirmation: 'Preenchido',
    }[status] || status
  )
}
async function loadAccounts() {
  const seq = ++loadAccountsSeq
  $('queue').innerHTML = '<div class="empty">Carregando perfis...</div>'
  try {
    const { accounts } = await request('/extension/accounts')
    if (seq !== loadAccountsSeq) return
    const { activeAccountId: saved } = await chrome.storage.local.get('activeAccountId')
    if (seq !== loadAccountsSeq) return
    availableAccounts = accounts
    const selected = accounts.find((account) => account.id === Number(saved)) || accounts[0]
    $('accountSelect').innerHTML = ''
    accounts.forEach((account) => {
      const option = document.createElement('option')
      option.value = String(account.id)
      option.textContent = `${account.label} · ${account.owner}`
      $('accountSelect').appendChild(option)
    })
    if (!selected) {
      activeAccountId = 0
      $('profileMeta').textContent = 'Nenhum perfil associado. Cadastre um em Equipe e contas.'
      $('accountSelect').disabled = true
      $('autoRun').disabled = true
      $('queue').innerHTML =
        '<div class="empty">Associe um perfil do Brave antes de usar a fila.</div>'
      return
    }
    activeAccountId = selected.id
    $('accountSelect').disabled = false
    $('accountSelect').value = String(selected.id)
    $('autoRun').disabled = false
    updateProfileMeta(selected)
    await chrome.storage.local.set({ activeAccountId })
    if (seq !== loadAccountsSeq) return
    updateAutoRunButton()
    showManualLaunchError()
    loadQueue()
    // The background worker independently checks the admin's full-cycle
    // opt-in, even when this popup closes after a profile is selected.
    void chrome.runtime.sendMessage({ type: 'AUTOFLOW_SYNC_AUTONOMY' })
  } catch (error) {
    if (seq === loadAccountsSeq)
      $('queue').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`
  }
}
function updateProfileMeta(account) {
  const prefix = `Perfil local: ${account.browserProfile || 'não informado'}`
  $('profileMeta').textContent = prefix + ' · Facebook: verificação pendente'
  chrome.storage.local.get('facebookSession').then(({ facebookSession }) => {
    if (activeAccountId !== account.id) return
    if (facebookSession?.accountId !== account.id) return
    $('profileMeta').textContent =
      prefix +
      (facebookSession.ready
        ? ' · Facebook: formulário verificado'
        : ` · Facebook: ${facebookSession.reason || 'requer revisão'}`)
  })
}
function capacityPath(accountId = activeAccountId) {
  return '/social-accounts/' + encodeURIComponent(accountId) + '/capacity'
}
function renderCapacity() {
  const remaining = capacity ? Math.max(0, Math.ceil((capacityDeadline - Date.now()) / 1000)) : 0
  const blocked = !capacity || capacity.blockedByDailyLimit || remaining > 0
  const minutes = Math.floor(remaining / 60)
  const seconds = remaining % 60
  $('capacityTimer').textContent = capacity
    ? String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
    : '--:--'
  $('capacityState').textContent = !capacity
    ? 'Consultando intervalo...'
    : capacity.blockedByDailyLimit
      ? 'Limite diário atingido'
      : remaining > 0
        ? 'Perfil em espera'
        : 'Intervalo operacional livre'
  $('capacityMeta').textContent = capacity
    ? `Intervalo: ${capacity.intervalMinutes} min · Execuções: ${capacity.used}/${capacity.dailyLimit}` +
      (remaining > 0 && capacity.nextAllowedAt
        ? ' · Liberação: ' + new Date(capacity.nextAllowedAt).toLocaleTimeString('pt-BR')
        : '')
    : ''
  $('saveInterval').disabled = !capacity || capacityBusy
  $('releaseInterval').disabled =
    !capacity?.canReleaseFailedInterval || remaining === 0 || capacityBusy
  for (const button of $('queue').querySelectorAll('button[data-job-available="true"]'))
    button.disabled = blocked
}
function acceptCapacity(value, accountId) {
  if (accountId !== activeAccountId) return
  capacity = value
  capacityDeadline = Date.now() + Math.max(0, Number(value.retryAfterSeconds) || 0) * 1000
  if (capacityInputAccount !== accountId) {
    $('intervalInput').value = value.intervalMinutesOverride ?? ''
    capacityInputAccount = accountId
  }
  renderCapacity()
}
async function loadCapacity() {
  if (!activeAccountId || !token || capacityBusy) return
  const accountId = activeAccountId
  const seq = ++capacitySeq
  try {
    const value = await request(capacityPath(accountId))
    if (seq !== capacitySeq || accountId !== activeAccountId) return
    acceptCapacity(value, accountId)
    $('capacityError').textContent = ''
  } catch (error) {
    if (seq !== capacitySeq || accountId !== activeAccountId) return
    capacity = null
    $('capacityError').textContent = error.message
    renderCapacity()
  }
}
async function changeCapacity(release = false) {
  if (!canManageCapacity || !capacity || capacityBusy || !activeAccountId) return
  const accountId = activeAccountId
  const input = $('intervalInput').value.trim()
  const interval = input === '' ? null : Number(input)
  if (!release && interval !== null && (!Number.isInteger(interval) || interval < 0 || interval > 1440)) {
    $('capacityError').textContent = 'Informe um intervalo inteiro de 0 a 1440 minutos.'
    return
  }
  if (release && !confirm('Liberar somente o intervalo da última tentativa com falha? O consumo automático desta extensão será pausado.')) return
  capacityBusy = true
  capacitySeq++
  renderCapacity()
  try {
    if (release) {
      await chrome.storage.local.set({ autoRun: false, autoRunManuallyPaused: true, autoRunManaged: false })
      updateAutoRunButton()
    }
    const value = await request(capacityPath(accountId), {
      method: release ? 'POST' : 'PATCH',
      body: JSON.stringify(release
        ? { action: 'release_failed_interval', confirm: true }
        : { dailyLimitOverride: capacity.dailyLimitOverride, intervalMinutesOverride: interval }),
    })
    if (accountId !== activeAccountId) return
    capacityInputAccount = 0
    acceptCapacity(value, accountId)
    $('capacityError').textContent = release ? 'Intervalo liberado. Inicie o próximo trabalho manualmente.' : 'Intervalo salvo.'
    loadQueue()
  } catch (error) {
    if (accountId === activeAccountId) $('capacityError').textContent = error.message
  } finally {
    capacityBusy = false
    renderCapacity()
  }
}
$('saveInterval').onclick = () => void changeCapacity()
$('releaseInterval').onclick = () => void changeCapacity(true)
setInterval(() => {
  if (!capacity || !activeAccountId) return
  renderCapacity()
}, 1000)
setInterval(() => void loadCapacity(), 15000)

function loadQueue() {
  const seq = ++loadQueueSeq
  if (!activeAccountId) return
  void loadCapacity()
  $('queue').innerHTML = '<div class="empty">Carregando...</div>'
  request('/extension/queue?accountId=' + encodeURIComponent(activeAccountId))
    .then(({ jobs, account, automation }) => {
      if (seq !== loadQueueSeq) return
      if (account) updateProfileMeta({ ...account, status: 'connected' })
      const steps = ['Preencher dados']
      if (automation?.autoAdvance) steps.push('Avançar')
      if (automation?.fillGroups) steps.push(`${automation.targetGroups?.length || 0} grupos`)
      if (automation?.autoPublish) steps.push('Publicar')
      $('automationTitle').textContent = automation?.autoPublish
        ? 'Publicação automática ativa'
        : 'Confirmação final manual'
      $('automationSummary').textContent =
        steps.join(' → ') + (automation?.autoPublish ? '' : ' → revisar e publicar manualmente')
      $('queue').innerHTML = jobs.length
        ? ''
        : '<div class="empty">Nenhum trabalho pendente para este perfil.<br><small>No painel, use ⋯ → Adicionar à fila e escolha este perfil.</small></div>'
      jobs.forEach((job) => {
        const card = document.createElement('div')
        const locked = Boolean(job.locked || job.publishUncertain)
        card.className = `vehicle ${locked ? 'locked-job' : job.jobStatus === 'error' ? 'error-job' : job.jobStatus === 'filling' ? 'filling-job' : job.jobStatus === 'awaiting_confirmation' ? 'filled-job' : ''}`
        const action = job.publishUncertain
          ? 'Resultado de publicação a confirmar'
          : locked
            ? 'Em uso em outra aba'
            : job.jobStatus === 'pending'
              ? 'Abrir e preencher'
              : job.jobStatus === 'awaiting_confirmation'
                ? 'Preencher novamente'
                : 'Retomar preenchimento'
        card.innerHTML = `<div class="vehicle-top"><strong>${Number(job.year)} ${escapeHtml(job.make)} ${escapeHtml(job.model)}</strong><span class="status ${locked ? 'locked' : escapeHtml(job.jobStatus)}">${job.publishUncertain ? 'Resultado incerto' : locked ? 'Em execução' : statusLabel(job.jobStatus)}</span></div><small>${Number(job.km).toLocaleString('pt-BR')} km · ${Number(job.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })} · ${Number(job.imageCount || 0)} fotos</small><div class="job-meta">Trabalho #${Number(job.jobId)} · ${escapeHtml(job.accountLabel)}${job.errorCode ? ' · ' + escapeHtml(job.errorCode) : ''}</div><button data-id="${Number(job.jobId)}" ${locked ? 'disabled title="Resolva a pendência no painel antes de repetir."' : ''}>${action}</button>`
        const hide = document.createElement('button')
        hide.type = 'button'
        hide.className = 'hide-job'
        hide.textContent = '×'
        hide.title = locked ? 'Revise a execução no painel antes de retirar.' : 'Retirar da fila da extensão'
        hide.setAttribute('aria-label', 'Retirar trabalho #' + Number(job.jobId) + ' da extensão')
        hide.disabled = locked
        hide.onclick = () => void hideQueueJob(job.jobId, activeAccountId, hide)
        card.querySelector('.vehicle-top').appendChild(hide)
        if (!locked) {
          const button = card.querySelector('button[data-id]')
          button.dataset.jobAvailable = 'true'
          button.onclick = () => prepare(job.jobId)
        }
        $('queue').appendChild(card)
      })
      renderCapacity()
    })
    .catch((error) => {
      if (seq === loadQueueSeq)
        $('queue').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`
    })
}
async function hideQueueJob(jobId, accountId, button) {
  if (!accountId || button.disabled) return
  button.disabled = true
  try {
    await request('/extension/jobs/' + encodeURIComponent(jobId) + '/hide', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    })
    if (accountId !== activeAccountId) return
    loadQueue()
  } catch (error) {
    if (accountId !== activeAccountId) return
    alert(error.message)
    loadQueue()
  }
}
function prepare(jobId) {
  if (!capacity || capacity.blockedByDailyLimit || capacityDeadline > Date.now()) {
    void loadCapacity()
    return
  }
  if (!instanceId) {
    alert('A identificação local da extensão ainda está carregando. Tente novamente.')
    return
  }
  chrome.storage.local.get(['pendingJob'], (state) => {
    if (state.pendingJob?.jobId) {
      chrome.tabs.get(state.pendingJob.tabId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          chrome.tabs.update(tab.id, { active: true })
          alert(`O trabalho #${state.pendingJob.jobId} já está ativo nesta extensão.`)
          return
        }
        chrome.storage.local.remove('pendingJob', () => openJob(jobId))
      })
      return
    }
    openJob(jobId)
  })
}
async function openJob(jobId) {
  if (openingJob) return
  openingJob = true
  try {
    // The popup can disappear as soon as a new tab becomes active.
    // The background worker owns the entire launch and reservation.
    const result = await chrome.runtime.sendMessage({
      type: 'AUTOFLOW_START_MANUAL_JOB',
      jobId,
      accountId: activeAccountId,
      instanceId,
    })
    if (!result?.ok)
      throw new Error(result?.error || 'A extensão não confirmou o início do preenchimento.')
  } catch (error) {
    alert(error.message)
  } finally {
    openingJob = false
  }
}
function showManualLaunchError() {
  chrome.storage.local.get('lastManualLaunchError', ({ lastManualLaunchError }) => {
    const notice = $('dispatchError')
    if (!notice) return
    if (!lastManualLaunchError || Date.now() - lastManualLaunchError.at > 30 * 60_000) {
      notice.hidden = true
      notice.textContent = ''
      return
    }
    notice.hidden = false
    notice.textContent = `Trabalho #${Number(lastManualLaunchError.jobId)}: ${String(lastManualLaunchError.message || 'Falha ao abrir o formulário.')}`
  })
}
function updateAutoRunButton() {
  chrome.storage.local.get('autoRun', ({ autoRun }) => {
    $('autoRun').textContent = autoRun ? 'Pausar consumo automático' : 'Iniciar consumo automático'
    $('autoRun').classList.toggle('running', Boolean(autoRun))
    $('autoRun').setAttribute('aria-pressed', String(Boolean(autoRun)))
  })
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
}
$('login').onclick = async () => {
  $('loginError').textContent = ''
  $('login').disabled = true
  try {
    const data = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('email').value,
        password: $('password').value,
        extensionClient: true,
      }),
    })
    token = data.token
    await chrome.storage.local.set({
      token,
      refreshToken: data.refreshToken || null,
      user: data.user,
      authNeeded: false,
    })
    setConnected(true, data.user)
    await loadAccounts()
  } catch (error) {
    $('loginError').textContent = error.message
  } finally {
    $('password').value = ''
    $('login').disabled = false
  }
}
$('logout').onclick = async () => {
  loadAccountsSeq++
  loadQueueSeq++
  try {
    await request('/auth/logout', { method: 'POST' })
  } catch (error) {
    console.warn(
      'AutoFlow: não foi possível revogar a sessão no servidor',
      error instanceof Error ? error.message : String(error),
    )
  }
  chrome.storage.local.remove(
    [
      'token',
      'refreshToken',
      'user',
      'activeAccountId',
      'pendingJob',
      'autoRun',
      'autoRunManaged',
      'autoRunManuallyPaused',
      'facebookSession',
    ],
    () => {
      token = ''
      activeAccountId = 0
      setConnected(false)
      updateAutoRunButton()
    },
  )
}
$('refresh').onclick = loadQueue
$('autoRun').onclick = () =>
  chrome.storage.local.get('autoRun', ({ autoRun }) => {
    const next = !autoRun
    chrome.storage.local.set(
      { autoRun: next, autoRunManuallyPaused: !next, autoRunManaged: false },
      () => {
        updateAutoRunButton()
        if (next) chrome.runtime.sendMessage({ type: 'AUTOFLOW_RUN_QUEUE' })
      },
    )
  })
$('accountSelect').onchange = () => {
  activeAccountId = Number($('accountSelect').value)
  capacitySeq++
  capacity = null
  capacityInputAccount = 0
  renderCapacity()
  const account = availableAccounts.find((item) => item.id === activeAccountId)
  if (account) updateProfileMeta(account)
  chrome.storage.local.set(
    {
      activeAccountId,
      autoRun: false,
      autoRunManaged: false,
      autoRunManuallyPaused: false,
    },
    () => {
      updateAutoRunButton()
      loadQueue()
      void chrome.runtime.sendMessage({ type: 'AUTOFLOW_SYNC_AUTONOMY' })
    },
  )
}
chrome.storage.local.get(['token', 'refreshToken', 'user', 'instanceId'], (data) => {
  instanceId =
    data.instanceId ||
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`
  if (!data.instanceId) chrome.storage.local.set({ instanceId })
  token = data.token || ''
  if (token || data.refreshToken) {
    request('/me')
      .then(({ user }) => {
        setConnected(true, user)
        loadAccounts()
      })
      .catch(() => setConnected(false))
  } else setConnected(false)
})
