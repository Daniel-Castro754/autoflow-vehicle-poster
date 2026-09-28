;(function () {
  if (window.__autoflowLoaded) return
  window.__autoflowLoaded = true

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const randomDelay = (min, max) => sleep(min + Math.random() * (max - min))
  const selectorConfig = globalThis.AUTOFLOW_SELECTOR_CONFIG || {
    version: 'embedded',
    fallbackLocale: 'pt-BR',
    supportedLocales: ['pt-BR', 'en-US'],
    aliases: {},
    fields: {},
  }
  function detectPageLocale() {
    const declared = String(
      document.documentElement?.lang || globalThis.navigator?.language || '',
    ).toLowerCase()
    if (declared.startsWith('es')) return 'es-ES'
    if (declared.startsWith('en')) return 'en-US'
    if (declared.startsWith('pt')) return 'pt-BR'
    const sample = String(document.body?.innerText || '')
      .slice(0, 6000)
      .toLowerCase()
    if (/\b(precio|ubicaci[oó]n|kilometraje|descripci[oó]n)\b/.test(sample)) return 'es-ES'
    if (/\b(price|location|mileage|description)\b/.test(sample)) return 'en-US'
    return selectorConfig.fallbackLocale || 'pt-BR'
  }
  const pageLocale = detectPageLocale()
  function fieldLabels(fieldName, fallback = []) {
    const spec = selectorConfig.fields?.[fieldName]
    const localized = spec?.labels?.[pageLocale] || []
    const fallbackLocalized = spec?.labels?.[selectorConfig.fallbackLocale] || []
    const allKnown = Object.values(spec?.labels || {}).flat()
    return [
      ...new Set([...localized, ...fallbackLocalized, ...allKnown, ...fallback].filter(Boolean)),
    ]
  }
  // Marcado por fillText/selectCustom quando o controle não é localizado no DOM (diferente
  // de "localizado, mas o valor não confirmou") — usado por step() para sinalizar possível
  // mudança de layout do Facebook em vez de um problema pontual de dados do veículo.
  let lastFieldNotFound = false
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const visible = (element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return (
      box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    )
  }
  const attributeText = (element) => {
    const labelledBy = String(element.getAttribute?.('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || '')
    const ownLabel = element.id
      ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent
      : ''
    return normalize(
      [
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('placeholder'),
        element.getAttribute?.('name'),
        element.getAttribute?.('data-testid'),
        ownLabel,
        ...labelledBy,
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  const exactOrPrefix = (text, key) =>
    text === key || text.startsWith(key + ' ') || text.endsWith(' ' + key)
  const fuzzyMatch = (text, value) => {
    const a = normalize(text),
      b = normalize(value)
    if (!a || !b) return false
    if (a === b || a.includes(b) || b.includes(a)) return true
    const tokens = b.split(' ').filter((token) => token.length > 2)
    return tokens.length > 0 && tokens.every((token) => a.includes(token))
  }

  const aliases = {
    'carro caminhonete': ['Carro/picape', 'Carro/Caminhonete'],
    'carro picape': ['Carro/picape', 'Carro/Caminhonete'],
    'outro veiculo': ['Outro'],
    hatch: ['Hatchback', 'Hatch'],
    perua: ['Perua/Station wagon', 'Perua'],
    automatico: ['Automático'],
    prateado: ['Prateado', 'Prata'],
    ...(selectorConfig.aliases || {}),
  }
  function valuesFor(value) {
    const key = normalize(value)
    return aliases[key] || [String(value)]
  }

  function setNative(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter?.call(input, String(value))
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', bubbles: true }))
    input.dispatchEvent(new Event('blur', { bubbles: true }))
  }

  async function typeLikeHuman(input, value) {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) return false
    input.focus()
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    let current = ''
    for (const character of String(value)) {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: character, bubbles: true, cancelable: true }),
      )
      current += character
      setter.call(input, current)
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: character,
        }),
      )
      input.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }))
      await randomDelay(18, 58)
    }
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()
    return true
  }

  function valueMatches(actual, expected) {
    const current = normalize(actual),
      wanted = normalize(expected)
    if (!current || !wanted) return false
    const currentDigits = current.replace(/\D/g, ''),
      wantedDigits = wanted.replace(/\D/g, '')
    if (wantedDigits.length >= 3 && currentDigits) return currentDigits === wantedDigits
    return valuesFor(expected).some((candidate) => fuzzyMatch(current, candidate))
  }

  function fieldValue(element) {
    if (element instanceof HTMLSelectElement)
      return element.selectedOptions[0]?.textContent || element.value
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      return element.value
    return [
      element.getAttribute?.('aria-valuetext'),
      element.getAttribute?.('data-value'),
      element.innerText,
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
  }

  async function confirmField(labels, value, selector) {
    return Boolean(
      await waitForDom(() => {
        const current = findField(labels, selector)
        return current && valueMatches(fieldValue(current), value)
      }, 2200),
    )
  }

  function rootScope() {
    return (
      [...document.querySelectorAll('[role="main"],form')].find(
        (element) => visible(element) && element.querySelector('input,textarea,[role="combobox"]'),
      ) || document.body
    )
  }
  function labelNodes(labels) {
    const keys = labels.map(normalize)
    return [...rootScope().querySelectorAll('label,span,div')]
      .filter((element) => {
        if (!visible(element)) return false
        const text = normalize(element.textContent)
        if (!text || text.length > 80) return false
        return keys.some((key) => exactOrPrefix(text, key))
      })
      .sort((a, b) => String(a.textContent).length - String(b.textContent).length)
  }

  function commonAncestorBonus(label, control) {
    let node = label
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      if (node.contains(control)) return 300 - depth * 35
    }
    return 0
  }

  function findField(labels, selector, { allowHidden = false } = {}) {
    const keys = labels.map(normalize)
    const controls = [...rootScope().querySelectorAll(selector)].filter(
      (element) => allowHidden || visible(element),
    )
    const direct = controls.find((element) =>
      keys.some((key) => attributeText(element).includes(key)),
    )
    if (direct) return direct
    const labelsFound = labelNodes(labels)
    let best = null,
      bestScore = -Infinity
    for (const control of controls) {
      const controlBox = control.getBoundingClientRect()
      for (const label of labelsFound) {
        const labelBox = label.getBoundingClientRect()
        const ancestor = commonAncestorBonus(label, control)
        const horizontalGap = Math.max(
          0,
          Math.max(labelBox.left - controlBox.right, controlBox.left - labelBox.right),
        )
        const verticalGap = Math.max(
          0,
          controlBox.top - labelBox.bottom,
          labelBox.top - controlBox.bottom,
        )
        const sameColumn = horizontalGap < Math.max(35, controlBox.width * 0.4)
        const score = ancestor + (sameColumn ? 180 : 0) - horizontalGap * 1.5 - verticalGap * 2
        if (verticalGap < 150 && score > bestScore) {
          best = control
          bestScore = score
        }
      }
    }
    return bestScore > 40 ? best : null
  }

  async function waitField(labels, selector, options, attempts = 24) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const field = findField(labels, selector, options)
      if (field) return field
      await sleep(250)
    }
    return null
  }

  async function fillText(labels, value, { humanTyping = false } = {}) {
    if (value === undefined || value === null || value === '') return false
    const element = await waitField(
      labels,
      'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]',
    )
    if (!element) {
      lastFieldNotFound = true
      return false
    }
    element.scrollIntoView({ block: 'center', behavior: 'auto' })
    await sleep(180)
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (humanTyping) {
        await typeLikeHuman(element, value)
        if (
          await confirmField(
            labels,
            value,
            'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]',
          )
        )
          return true
      }
      setNative(element, value)
      if (
        await confirmField(
          labels,
          value,
          'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]',
        )
      )
        return true
      element.focus()
      element.select?.()
      document.execCommand('insertText', false, String(value))
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }),
      )
      element.dispatchEvent(new Event('change', { bubbles: true }))
      element.blur()
    } else {
      element.focus()
      document.execCommand('selectAll', false)
      document.execCommand('insertText', false, String(value))
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      element.dispatchEvent(new Event('blur', { bubbles: true }))
    }
    return confirmField(
      labels,
      value,
      'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]',
    )
  }

  function optionCandidates(trigger) {
    const controlledId =
      trigger.getAttribute?.('aria-controls') || trigger.getAttribute?.('aria-owns')
    const controlled = controlledId ? document.getElementById(controlledId) : null
    const roots =
      controlled && visible(controlled)
        ? [controlled]
        : [...document.querySelectorAll('[role="listbox"],[role="menu"]')].filter(visible)
    const roleOptions = roots
      .flatMap((root) => [
        ...root.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"]'),
      ])
      .filter(visible)
    if (roleOptions.length) return roleOptions
    return [...document.querySelectorAll('[role="option"],[role="menuitemradio"]')].filter(visible)
  }

  function scrollOpenList(trigger) {
    const controlledId =
      trigger.getAttribute?.('aria-controls') || trigger.getAttribute?.('aria-owns')
    const controlled = controlledId ? document.getElementById(controlledId) : null
    const host =
      controlled || [...document.querySelectorAll('[role="listbox"]')].filter(visible).at(-1)
    if (!host) return false
    const scrollable = [host, ...host.querySelectorAll('div')]
      .filter((element) => element.scrollHeight > element.clientHeight + 8)
      .sort((a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))[0]
    if (!scrollable) return false
    const before = scrollable.scrollTop
    scrollable.scrollTop = Math.min(
      scrollable.scrollHeight,
      scrollable.scrollTop + Math.max(120, scrollable.clientHeight * 0.75),
    )
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }))
    return scrollable.scrollTop !== before
  }

  async function selectCustom(labels, value) {
    if (value === undefined || value === null || value === '') return false
    const trigger = await waitField(
      labels,
      'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]',
    )
    if (!trigger) {
      lastFieldNotFound = true
      return false
    }
    const wanted = valuesFor(value)
    if (trigger instanceof HTMLSelectElement) {
      const option = [...trigger.options].find((item) =>
        wanted.some((candidate) => fuzzyMatch(item.textContent, candidate)),
      )
      if (!option) return false
      trigger.value = option.value
      trigger.dispatchEvent(new Event('input', { bubbles: true }))
      trigger.dispatchEvent(new Event('change', { bubbles: true }))
      trigger.dispatchEvent(new Event('blur', { bubbles: true }))
      return confirmField(
        labels,
        value,
        'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]',
      )
    }
    trigger.scrollIntoView({ block: 'center', behavior: 'auto' })
    await sleep(180)
    trigger.click()
    await sleep(420)
    for (let attempt = 0; attempt < 36; attempt++) {
      const options = optionCandidates(trigger)
      const exact = options.find((option) =>
        wanted.some((candidate) => normalize(option.textContent) === normalize(candidate)),
      )
      const match =
        exact ||
        options.find((option) =>
          wanted.some((candidate) => fuzzyMatch(option.textContent, candidate)),
        )
      if (match) {
        match.scrollIntoView({ block: 'nearest', behavior: 'auto' })
        firePointerClick(match)
        await sleep(420)
        if (
          await confirmField(
            labels,
            value,
            'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]',
          )
        )
          return true
        const checked =
          match.getAttribute('aria-selected') === 'true' ||
          match.getAttribute('aria-checked') === 'true'
        if (checked) return true
      }
      if (attempt > 0 && attempt % 3 === 0) scrollOpenList(trigger)
      await sleep(140)
    }
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    )
    if (trigger instanceof HTMLInputElement) {
      trigger.focus()
      setNative(trigger, wanted[0])
      await sleep(500)
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }),
      )
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
      )
      trigger.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }),
      )
      if (
        await confirmField(
          labels,
          value,
          'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]',
        )
      )
        return true
    }
    return false
  }

  async function selectOrFill(labels, value, { humanTyping = false } = {}) {
    if (await selectCustom(labels, value)) return true
    const filled = await fillText(labels, value, { humanTyping })
    if (!filled) return false
    await sleep(500)
    const suggestions = [...document.querySelectorAll('[role="option"]')].filter(visible)
    const match = suggestions.find((option) =>
      valuesFor(value).some((candidate) => fuzzyMatch(option.textContent, candidate)),
    )
    if (match) {
      firePointerClick(match)
      await sleep(320)
    }
    return confirmField(
      labels,
      value,
      'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"],[role="combobox"]',
    )
  }

  function contextError(error) {
    return /Extension context invalidated/i.test(error?.message || '')
      ? Object.assign(new Error('Extensão recarregada. Reabra a aba do Marketplace.'), {
          code: 'CONTEXT_INVALIDATED',
        })
      : error
  }
  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime?.id)
          throw Object.assign(new Error('Extensão recarregada.'), { code: 'CONTEXT_INVALIDATED' })
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const error = chrome.runtime.lastError
            if (error) return reject(contextError(new Error(error.message)))
            if (!response?.ok) return reject(new Error(response?.error || 'Falha na extensão.'))
            resolve(response)
          } catch (error) {
            reject(contextError(error))
          }
        })
      } catch (error) {
        reject(contextError(error))
      }
    })
  }
  function startExecutionActivity(task) {
    if (!task?.jobId || !task.documentId) return () => {}
    let stopped = false
    const ping = () => {
      if (stopped) return
      void runtimeMessage({
        type: 'AUTOFLOW_EXECUTION_ACTIVITY',
        jobId: task.jobId,
        document: location.pathname,
        documentId: task.documentId,
      }).catch((error) => {
        if (error.code === 'CONTEXT_INVALIDATED') {
          stopped = true
          clearInterval(timer)
        }
      })
    }
    const timer = setInterval(ping, 15_000)
    ping()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  function photoCount() {
    const match = (document.body.innerText || '').match(
      /Fotos?\s*(?:[\u00b7:-]\s*)?(\d+)\s*\/\s*20/i,
    )
    return match ? Number(match[1]) : null
  }

  function photoInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')]
    let best = null,
      bestScore = -Infinity
    for (const input of inputs) {
      let score = 0
      const accept = normalize(input.getAttribute('accept'))
      if (accept.includes('image')) score += 300
      if (input.multiple) score += 120
      let node = input.parentElement
      for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
        const text = normalize(node.innerText || node.textContent)
        if (text.includes('upload de fotos')) score += 600 - depth * 30
        else if (text.includes('adicione fotos') || text.includes('adicionar foto'))
          score += 420 - depth * 25
        const box = node.getBoundingClientRect()
        if (box.width > 0 && box.height > 0 && box.left < window.innerWidth * 0.45) score += 30
      }
      if (score > bestScore) {
        best = input
        bestScore = score
      }
    }
    return bestScore >= 300 ? best : null
  }

  function fileFromBase64(dataBase64, name, mimeType) {
    const binary = atob(dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return new File([bytes], name, { type: mimeType || 'image/jpeg' })
  }

  const imageUploads = new Map()
  async function uploadImages(images) {
    if (!Array.isArray(images) || !images.length) return 0
    const target = images.slice(0, 20)
    const key = JSON.stringify(target.map((image) => image.url))
    let state = imageUploads.get(key)
    const initial = photoCount() || 0
    if (initial >= target.length) return initial
    // Unknown existing photos cannot be mapped to source files safely.
    if (!state && initial > 0) return initial
    if (!state) {
      state = { completed: new Set(), awaiting: null }
      imageUploads.set(key, state)
    }
    if (state.awaiting) {
      if (initial === state.awaiting.before + 1) {
        state.completed.add(state.awaiting.index)
        state.awaiting = null
      } else return initial
    }
    for (let index = 0; index < target.length; index++) {
      if (state.completed.has(index)) continue
      let input = null
      for (let attempt = 0; attempt < 24 && !input; attempt++) {
        input = photoInput()
        if (!input) await sleep(250)
      }
      if (!input) return photoCount() || 0
      let response
      try {
        response = await runtimeMessage({ type: 'AUTOFLOW_FETCH_IMAGE', url: target[index].url })
      } catch (error) {
        if (error.code === 'CONTEXT_INVALIDATED') throw error
        return photoCount() || 0
      }
      const before = photoCount()
      if (before === null || before !== state.completed.size) return before || 0
      const transfer = new DataTransfer()
      transfer.items.add(
        fileFromBase64(
          response.dataBase64,
          target[index].name || `veiculo-${index + 1}.jpg`,
          target[index].mimeType || response.mimeType,
        ),
      )
      state.awaiting = { index, before }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set
      if (setter) setter.call(input, transfer.files)
      else Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await sleep(500)
        const accepted = photoCount()
        if (accepted === before + 1) {
          state.completed.add(index)
          state.awaiting = null
          break
        }
        if (accepted !== null && accepted !== before) return accepted
      }
      if (state.awaiting) return photoCount() || before
    }
    return photoCount() || 0
  }

  function controlText(element) {
    return normalize(
      [
        element.innerText,
        element.textContent,
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
      ]
        .filter(Boolean)
        .join(' '),
    )
  }
  function controlEnabled(element) {
    return Boolean(
      element &&
      visible(element) &&
      element.getAttribute('aria-disabled') !== 'true' &&
      !element.disabled &&
      !element.closest('[aria-disabled="true"]'),
    )
  }

  function actionButton(names) {
    const keys = names.map(normalize)
    const candidates = [
      ...document.querySelectorAll(
        'button,[role="button"],input[type="button"],input[type="submit"]',
      ),
    ].filter(controlEnabled)
    let best = null,
      bestScore = -Infinity
    for (const button of candidates) {
      const text = controlText(button) || normalize(button.value)
      const exact = keys.some((key) => text === key)
      const contained = keys.some((key) => exactOrPrefix(text, key) || text.includes(key))
      if (!exact && !contained) continue
      const box = button.getBoundingClientRect()
      let score = exact ? 1000 : 500
      if (box.left < window.innerWidth * 0.42) score += 180
      if (box.top > window.innerHeight * 0.55) score += 120
      if (button.tagName === 'BUTTON') score += 40
      if (score > bestScore) {
        best = button
        bestScore = score
      }
    }
    return best
  }

  function firePointerClick(element) {
    element.focus?.({ preventScroll: true })
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
    }
    try {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...init,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      )
    } catch {
      /* navegador sem PointerEvent */
    }
    element.dispatchEvent(new MouseEvent('mousedown', init))
    try {
      element.dispatchEvent(
        new PointerEvent('pointerup', {
          ...init,
          buttons: 0,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      )
    } catch {
      /* navegador sem PointerEvent */
    }
    element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
    element.click()
  }

  function waitForDom(test, timeout = 20000) {
    const current = test()
    if (current) return Promise.resolve(current)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        observer.disconnect()
        clearInterval(poll)
        clearTimeout(deadline)
        resolve(value)
      }
      const check = () => {
        const value = test()
        if (value) finish(value)
      }
      const observer = new MutationObserver(check)
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'aria-checked', 'disabled', 'href'],
      })
      const poll = setInterval(check, 350)
      const deadline = setTimeout(() => finish(null), timeout)
    })
  }

  function hasHumanChallenge() {
    const text = normalize(document.body.innerText)
    return [
      'captcha',
      'confirme que voce e humano',
      'verificacao de seguranca',
      'security check',
    ].some((value) => text.includes(value))
  }

  function marketplaceStage() {
    const text = normalize(document.body.innerText)
    if (
      /\/marketplace\/item\//.test(location.pathname) ||
      text.includes('seu classificado foi publicado')
    )
      return 'published'
    if (
      text.includes('anunciar em mais locais') ||
      text.includes('anunciar nos seus grupos') ||
      actionButton(['Publicar', 'Publish'])
    )
      return 'groups'
    if (actionButton(['Avançar', 'Next'])) return 'details'
    return 'unknown'
  }

  async function advanceToGroups(repair) {
    if (marketplaceStage() === 'groups') return true
    for (let attempt = 0; attempt < 3; attempt++) {
      let button = await waitForDom(
        () => actionButton(['Avançar', 'Next']),
        attempt === 0 ? 8000 : 5000,
      )
      if (!button && repair) {
        await repair(attempt)
        button = await waitForDom(() => actionButton(['Avançar', 'Next']), 6000)
      }
      if (!button) continue
      button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' })
      await sleep(350)
      firePointerClick(button)
      const advanced = await waitForDom(() => marketplaceStage() === 'groups', 9000)
      if (advanced) return true
      if (repair) await repair(attempt)
      await sleep(700)
    }
    return false
  }

  function groupTarget(raw) {
    const value = String(raw || '').trim()
    const parts = value
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean)
    const urlPart =
      parts.find((part) => /facebook\.com\/groups\//i.test(part)) ||
      (/facebook\.com\/groups\//i.test(value) ? value : '')
    const idMatch = urlPart.match(/facebook\.com\/groups\/([^/?#]+)/i)
    const name = parts.find((part) => part !== urlPart) || (!urlPart ? value : '')
    return {
      raw: value,
      name,
      normalizedName: normalize(name),
      groupId: normalize(idMatch?.[1] || ''),
    }
  }

  function checkboxState(checkbox) {
    return checkbox instanceof HTMLInputElement
      ? checkbox.checked
      : checkbox.getAttribute('aria-checked') === 'true'
  }

  function groupRow(target) {
    const candidates = [
      ...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]'),
    ].filter(visible)
    let best = null,
      bestScore = -Infinity
    for (const checkbox of candidates) {
      let node = checkbox
      for (let depth = 0; node && depth < 9; depth++, node = node.parentElement) {
        const text = normalize(node.innerText || node.textContent)
        const links = [...node.querySelectorAll('a[href*="/groups/"]')].map((link) =>
          normalize(link.getAttribute('href')),
        )
        const idMatch =
          target.groupId &&
          links.some(
            (href) => href.includes(`groups ${target.groupId}`) || href.includes(target.groupId),
          )
        const nameMatch =
          target.normalizedName &&
          (text === target.normalizedName ||
            text.startsWith(target.normalizedName + ' ') ||
            text.includes(target.normalizedName))
        if (!idMatch && !nameMatch) continue
        let score =
          (idMatch ? 1200 : 0) +
          (nameMatch ? 600 : 0) -
          depth * 25 -
          Math.max(0, text.length - target.normalizedName.length) * 0.15
        if (node.querySelectorAll('input[type="checkbox"],[role="checkbox"]').length === 1)
          score += 120
        if (score > bestScore) {
          best = { checkbox, row: node }
          bestScore = score
        }
      }
    }
    return best
  }

  function groupsScroller() {
    const candidates = [...document.querySelectorAll('div')].filter((element) => {
      if (!visible(element) || element.scrollHeight <= element.clientHeight + 30) return false
      const box = element.getBoundingClientRect()
      return box.left < window.innerWidth * 0.4 && box.height > 200
    })
    return (
      candidates.sort(
        (a, b) => b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
      )[0] || document.scrollingElement
    )
  }

  async function selectConfiguredGroups(groups) {
    const selected = [],
      missing = []
    for (const configured of groups.slice(0, 20)) {
      const target = groupTarget(configured)
      let scroller = groupsScroller(),
        match = null,
        lastTop = -1
      if (scroller) scroller.scrollTop = 0
      for (let attempt = 0; attempt < 90 && !match; attempt++) {
        match = groupRow(target)
        if (match) break
        scroller = groupsScroller()
        if (!scroller) break
        const before = scroller.scrollTop
        scroller.scrollTop = Math.min(
          scroller.scrollHeight,
          scroller.scrollTop + Math.max(180, scroller.clientHeight * 0.58),
        )
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
        await waitForDom(() => groupRow(target), 350)
        if (scroller.scrollTop === before || scroller.scrollTop === lastTop) break
        lastTop = scroller.scrollTop
      }
      if (!match) {
        missing.push(target.raw)
        continue
      }
      if (!checkboxState(match.checkbox)) {
        match.row.scrollIntoView({ block: 'center', behavior: 'auto' })
        await sleep(180)
        for (let attempt = 0; attempt < 2 && !checkboxState(match.checkbox); attempt++) {
          firePointerClick(match.checkbox)
          await waitForDom(() => checkboxState(match.checkbox), 1500)
        }
      }
      if (checkboxState(match.checkbox)) selected.push(target.raw)
      else missing.push(target.raw)
    }
    return { selected, missing }
  }

  async function publishListing(beforeClick, checkPermission, jobId, documentId) {
    if (hasHumanChallenge()) return { clicked: false, confirmed: false }
    if (marketplaceStage() !== 'groups') return { clicked: false, confirmed: false }
    const button = await waitForDom(() => actionButton(['Publicar', 'Publish']), 18000)
    if (!button || marketplaceStage() !== 'groups') return { clicked: false, confirmed: false }
    const initialUrl = location.href
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' })
    await sleep(400)
    if (hasHumanChallenge()) return { clicked: false, confirmed: false }
    const current = actionButton(['Publicar', 'Publish']) || button
    if (!controlEnabled(current)) return { clicked: false, confirmed: false }
    try {
      if (checkPermission) await checkPermission()
      if (!controlEnabled(current) || hasHumanChallenge())
        return { clicked: false, confirmed: false }
      if (beforeClick) await beforeClick()
    } catch (error) {
      await runtimeMessage({
        type: 'AUTOFLOW_PUBLISH_ABORTED',
        jobId,
        document: location.pathname,
        documentId,
      }).catch(() => {})
      return { clicked: false, confirmed: false, error: error.message || String(error) }
    }
    let confirmed = false
    try {
      firePointerClick(current)
      confirmed = Boolean(
        await waitForDom(() => {
          if (hasHumanChallenge()) return false
          return (
            (location.href !== initialUrl && /\/marketplace\/item\//.test(location.pathname)) ||
            marketplaceStage() === 'published'
          )
        }, 45000),
      )
    } catch (error) {
      console.warn('AutoFlow: a confirmação do clique não chegou', error)
    }
    return { clicked: true, confirmed }
  }

  async function step(label, run) {
    let notFound = false
    for (let attempt = 0; attempt < 2; attempt++) {
      await randomDelay(attempt ? 420 : 260, attempt ? 760 : 560)
      lastFieldNotFound = false
      try {
        if (await run()) return [label, true]
      } catch (error) {
        console.warn(`AutoFlow: falha em ${label}`, error)
      }
      notFound = lastFieldNotFound
    }
    return [label, false, notFound]
  }

  async function fill(task) {
    const vehicle = task.vehicle || task
    const jobId = task.jobId
    const automation = task.automation || {}
    const fieldSteps = [
      {
        key: 'vehicleType',
        label: 'Tipo de veículo',
        run: () =>
          selectCustom(
            fieldLabels('vehicleType', ['tipo de veiculo', 'vehicle type']),
            vehicle.vehicleType || 'Carro/picape',
          ),
        critical: true,
      },
      {
        key: 'location',
        label: 'Localização',
        run: () =>
          selectOrFill(fieldLabels('location', ['localizacao', 'location']), vehicle.location, {
            humanTyping: Boolean(selectorConfig.fields?.location?.humanTyping),
          }),
        critical: true,
      },
      {
        key: 'year',
        label: 'Ano',
        run: () => selectCustom(fieldLabels('year', ['ano', 'year']), String(vehicle.year)),
        critical: true,
      },
      {
        key: 'make',
        label: 'Fabricante',
        run: () => selectOrFill(fieldLabels('make', ['fabricante', 'marca', 'make']), vehicle.make),
        critical: true,
      },
      {
        key: 'model',
        label: 'Modelo',
        run: () =>
          selectOrFill(fieldLabels('model', ['modelo', 'model']), vehicle.model, {
            humanTyping: Boolean(selectorConfig.fields?.model?.humanTyping),
          }),
        critical: true,
      },
      {
        key: 'mileage',
        label: 'Quilometragem',
        run: () =>
          fillText(fieldLabels('mileage', ['quilometragem', 'mileage', 'odometro']), vehicle.km, {
            humanTyping: true,
          }),
        critical: true,
      },
      {
        key: 'price',
        label: 'Preço',
        run: () =>
          fillText(fieldLabels('price', ['preco', 'price']), vehicle.price, { humanTyping: true }),
        critical: true,
      },
      {
        key: 'transmission',
        label: 'Câmbio',
        run: () =>
          selectCustom(
            fieldLabels('transmission', ['cambio', 'transmissao', 'transmission']),
            vehicle.transmission,
          ),
        critical: true,
      },
      {
        key: 'fuelType',
        label: 'Combustível',
        run: () => selectCustom(fieldLabels('fuelType', ['combustivel', 'fuel']), vehicle.fuelType),
        critical: true,
      },
      {
        key: 'bodyType',
        label: 'Carroceria',
        run: () =>
          selectCustom(
            fieldLabels('bodyType', [
              'estilo da carroceria',
              'carroceria',
              'body style',
              'body type',
            ]),
            vehicle.bodyType,
          ),
        critical: true,
      },
      {
        key: 'condition',
        label: 'Condição do veículo',
        run: () =>
          selectCustom(
            fieldLabels('condition', ['condicao do veiculo', 'vehicle condition', 'condicao']),
            vehicle.condition,
          ),
        critical: true,
      },
      {
        key: 'exteriorColor',
        label: 'Cor externa',
        run: () =>
          selectCustom(
            fieldLabels('exteriorColor', ['cor externa', 'exterior color']),
            vehicle.exteriorColor,
          ),
        critical: false,
      },
      {
        key: 'interiorColor',
        label: 'Cor interna',
        run: () =>
          selectCustom(
            fieldLabels('interiorColor', ['cor interna', 'interior color']),
            vehicle.interiorColor,
          ),
        critical: false,
      },
      {
        key: 'description',
        label: 'Descrição',
        run: () =>
          fillText(fieldLabels('description', ['descricao', 'description']), vehicle.description),
        critical: true,
      },
    ]
    const expectedImageCount = Array.isArray(vehicle.images)
      ? Math.min(vehicle.images.length, 20)
      : 0
    const resultMap = new Map()
    for (const field of fieldSteps) resultMap.set(field.label, await step(field.label, field.run))
    let imageCount = await uploadImages(vehicle.images)
    resultMap.set('Fotos', ['Fotos', expectedImageCount > 0 && imageCount === expectedImageCount])
    const repairFields = async (attempt) => {
      const failed = fieldSteps.filter((field) => !resultMap.get(field.label)?.[1])
      const candidates = failed.length ? failed : fieldSteps.filter((field) => field.critical)
      for (const field of candidates) {
        const retried = await step(field.label, field.run)
        if (retried[1]) resultMap.set(field.label, retried)
      }
      if (imageCount < expectedImageCount && attempt === 0) {
        imageCount = await uploadImages(vehicle.images)
        resultMap.set('Fotos', [
          'Fotos',
          expectedImageCount > 0 && imageCount === expectedImageCount,
        ])
      }
    }
    let advanced = false,
      selectedGroups = [],
      missingGroups = [],
      published = false,
      publishAttempted = false
    const flowIssues = []
    if (automation.autoAdvance) {
      advanced = await advanceToGroups(repairFields)
      if (!advanced)
        flowIssues.push(
          'O Facebook não liberou a segunda etapa após as tentativas de preenchimento e correção.',
        )
      if (advanced && automation.fillGroups) {
        const configuredGroups = Array.isArray(automation.targetGroups)
          ? automation.targetGroups
          : []
        if (!configuredGroups.length) flowIssues.push('Nenhum grupo foi configurado.')
        else {
          const groupResult = await selectConfiguredGroups(configuredGroups)
          selectedGroups = groupResult.selected
          missingGroups = groupResult.missing
          if (missingGroups.length)
            flowIssues.push('A seleção de todos os grupos não foi confirmada.')
        }
      }
      const groupsReady =
        !automation.fillGroups || (selectedGroups.length > 0 && missingGroups.length === 0)
      const fieldsReady =
        [...resultMap.values()].every((item) => item[1]) &&
        expectedImageCount > 0 &&
        imageCount === expectedImageCount
      if (advanced && automation.autoPublish && groupsReady && fieldsReady && jobId) {
        const currentResults = [...resultMap.values()]
        const reportBeforePublish = {
          filledCount: currentResults.filter((item) => item[1]).length,
          totalCount: currentResults.length,
          imageCount,
          missing: currentResults.filter((item) => !item[1]).map((item) => item[0]),
          fields: currentResults.map((item) => ({ name: item[0], ok: Boolean(item[1]) })),
          advanced,
          selectedGroups,
          missingGroups: [],
          flowIssues: [],
          publishAttempted: true,
        }
        const publication = await publishListing(
          () =>
            runtimeMessage({
              type: 'AUTOFLOW_PUBLISH_STARTED',
              jobId,
              document: location.pathname,
              documentId: task.documentId,
              report: reportBeforePublish,
            }),
          () =>
            runtimeMessage({ type: 'AUTOFLOW_PUBLISH_CHECK', jobId, documentId: task.documentId }),
          jobId,
          task.documentId,
        )
        publishAttempted = publication.clicked
        published = publication.confirmed
        if (publication.clicked && !published) {
          flowIssues.push(
            'O clique em Publicar foi enviado, mas o Facebook não confirmou o resultado. A tentativa foi preservada para reconciliação; não será repetida automaticamente.',
          )
        } else if (!publication.clicked) {
          flowIssues.push(
            publication.error
              ? 'A publicação automática foi interrompida antes do clique.'
              : 'O botão Publicar não estava disponível; nenhum clique foi enviado.',
          )
        }
      } else if (automation.autoPublish && !advanced)
        flowIssues.push('Publicação bloqueada porque a etapa de grupos não foi aberta.')
      else if (automation.autoPublish && !groupsReady)
        flowIssues.push('Publicação bloqueada porque os grupos não foram confirmados.')
      else if (automation.autoPublish && !fieldsReady)
        flowIssues.push(
          'Publicação bloqueada porque todos os campos e fotos não foram confirmados.',
        )
    }
    const results = [...resultMap.values()]
    const missing = results.filter((item) => !item[1]).map((item) => item[0])
    if (advanced && missing.length)
      flowIssues.push(
        `O Facebook aceitou o avanço, mas o diagnóstico interno não confirmou: ${missing.join(', ')}.`,
      )
    // Campos críticos cujo controle não foi encontrado no DOM (não apenas valor não confirmado)
    // são um sinal muito mais forte de mudança de layout do que um dado que não bate com nenhuma opção.
    const notFoundFields = fieldSteps
      .filter((field) => field.critical && resultMap.get(field.label)?.[2])
      .map((field) => field.label)
    const criticalFields = fieldSteps.filter((field) => field.critical)
    const selectorHealth = {
      configVersion: String(selectorConfig.version || 'unknown'),
      pageLocale,
      criticalTotal: criticalFields.length,
      missingCount: notFoundFields.length,
      successRate:
        criticalFields.length > 0
          ? (criticalFields.length - notFoundFields.length) / criticalFields.length
          : 1,
      severe:
        notFoundFields.length >= 3 ||
        (criticalFields.length > 0 &&
          notFoundFields.length >= 2 &&
          notFoundFields.length / criticalFields.length >= 0.3),
    }
    const layoutDriftSuspected =
      notFoundFields.length >= 2 ||
      (automation.autoAdvance && !advanced && notFoundFields.length >= 1)
    showNotice(results, vehicle, {
      automation,
      advanced,
      selectedGroups,
      missingGroups,
      published,
      flowIssues,
    })
    if (!jobId) return true
    return reportResult({
      type: 'AUTOFLOW_FILL_RESULT',
      jobId,
      document: location.pathname,
      documentId: task.documentId,
      report: {
        filledCount: results.length - missing.length,
        totalCount: results.length,
        imageCount,
        missing,
        fields: results.map((item) => ({ name: item[0], ok: Boolean(item[1]) })),
        advanced,
        selectedGroups,
        missingGroups,
        published,
        publishAttempted,
        flowIssues,
        resultUrl: published ? location.href : '',
        layoutDriftSuspected,
        notFoundFields,
        selectorConfigVersion: selectorHealth.configVersion,
        pageLocale: selectorHealth.pageLocale,
        selectorHealth,
      },
    })
  }

  async function reportResult(message) {
    try {
      await runtimeMessage(message)
      return true
    } catch (error) {
      if (error.code === 'CONTEXT_INVALIDATED') throw error
      console.warn('AutoFlow: resultado preservado para reenvio pelo background', error)
      return false
    }
  }

  function showNotice(results, vehicle, flow) {
    document.getElementById('autoflow-notice')?.remove()
    const count = results.filter((item) => item[1]).length
    const missing = results.filter((item) => !item[1]).map((item) => item[0])
    const box = document.createElement('div')
    box.id = 'autoflow-notice'
    box.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#153b32;color:#fff;padding:14px 16px;border-radius:10px;box-shadow:0 8px 30px #0005;font:13px Arial;max-width:380px'
    const details = []
    if (missing.length) details.push('Revise: ' + missing.join(', ') + '.')
    else details.push('Todos os campos foram encontrados.')
    if (flow.automation.autoAdvance)
      details.push(flow.advanced ? 'Etapa de grupos aberta.' : 'Não foi possível avançar.')
    if (flow.automation.fillGroups)
      details.push(
        flow.missingGroups.length
          ? 'Grupos não encontrados: ' + flow.missingGroups.join(', ') + '.'
          : `${flow.selectedGroups.length} grupo(s) selecionado(s).`,
      )
    if (flow.automation.autoPublish)
      details.push(
        flow.published
          ? 'Publicação confirmada.'
          : 'Publicação automática interrompida; revise manualmente.',
      )
    else details.push('Publicação final manual.')
    if (flow.flowIssues?.length) details.push(flow.flowIssues.join(' '))
    const title = document.createElement('strong')
    title.style.cssText = 'display:block;margin-bottom:4px'
    title.textContent = `AutoFlow: ${count}/${results.length} campos preenchidos`
    const message = document.createElement('span')
    message.style.color = '#b9d2cc'
    message.textContent = `${vehicle.year} ${vehicle.make} ${vehicle.model}. ${details.join(' ')}`
    const button = document.createElement('button')
    button.style.cssText =
      'float:right;margin-top:10px;border:0;background:#36d09b;color:#12382f;border-radius:5px;padding:6px 9px;cursor:pointer'
    button.textContent = 'Entendi'
    button.onclick = () => box.remove()
    box.append(title, message, button)
    document.body.appendChild(box)
  }

  const runningJobs = new Set()
  async function run(task) {
    if (task?.jobId && runningJobs.has(task.jobId)) return
    if (task?.jobId) runningJobs.add(task.jobId)
    let boundTask = task
    let stopActivity = () => {}
    try {
      if (task?.jobId) {
        const execution = await runtimeMessage({
          type: 'AUTOFLOW_EXECUTION_STARTED',
          jobId: task.jobId,
          document: location.pathname,
        })
        boundTask = { ...task, documentId: execution.documentId }
      }
      if (task?.startupError) throw new Error(task.startupError)
      stopActivity = startExecutionActivity(boundTask)
      return await fill(boundTask)
    } catch (error) {
      if (contextError(error)?.code === 'CONTEXT_INVALIDATED') return false
      console.error('AutoFlow: falha no preenchimento', error)
      if (boundTask?.jobId && boundTask.documentId)
        return await reportResult({
          type: 'AUTOFLOW_FILL_ERROR',
          jobId: boundTask.jobId,
          document: location.pathname,
          documentId: boundTask.documentId,
          error: error.message || String(error),
          failureCode:
            task?.startupError === 'O formulário do Marketplace não ficou disponível.'
              ? 'marketplace_form_timeout'
              : '',
        })
      if (task?.jobId && !boundTask?.documentId) runningJobs.delete(task.jobId)
    } finally {
      stopActivity()
    }
  }
  chrome.storage.local.get(['pendingJob', 'pendingVehicle'], (data) => {
    const task = data.pendingJob || data.pendingVehicle
    if (!task) return
    let attempts = 0
    const timer = setInterval(() => {
      attempts++
      if (document.querySelector('input,textarea,[role="combobox"],[contenteditable="true"]')) {
        clearInterval(timer)
        run(task).finally(() => {
          try {
            return chrome.storage.local.remove('pendingVehicle').catch(() => {})
          } catch {
            /* contexto recarregado */
          }
        })
      } else if (attempts > 40) {
        clearInterval(timer)
        run({ ...task, startupError: 'O formulário do Marketplace não ficou disponível.' })
      }
    }, 500)
  })
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'AUTOFLOW_EXECUTION_PROBE') {
      sendResponse({ active: runningJobs.has(message.jobId) })
      return
    }
    if (message.type === 'FILL_VEHICLE') run(message.task || message.vehicle)
  })
})()
