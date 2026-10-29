/**
 * app.js —— 把骨架、角色、鼠标、气泡、大脑、嗓子串起来
 */
(function () {
  'use strict'

  const DW = 360
  const DH = 620

  const stage = document.getElementById('stage')
  const ctx = stage.getContext('2d')
  const dbgCanvas = document.getElementById('debug')
  const dctx = dbgCanvas.getContext('2d')
  const bubble = document.getElementById('bubble')
  const bubbleText = document.getElementById('bubble-text')
  const composer = document.getElementById('composer')
  const composerInput = document.getElementById('composer-input')
  const composerSend = document.getElementById('composer-send')

  const params = new URLSearchParams(location.search)
  const BG = params.get('bg') || 'none'
  const FORCE_STATE = params.get('state') || null
  const DEBUG = params.get('debug') === '1'
  if (DEBUG) dbgCanvas.classList.remove('hidden')

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
  const lerp = (a, b, t) => a + (b - a) * t
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const rig = new Rig()
  let character = new window.Characters.PlaceholderCharacter()

  // ---------------------------------------------------------------- 画布

  let W = DW
  let H = DH
  let sx = 1
  let sy = 1
  let dpr = 1

  function resize() {
    dpr = window.devicePixelRatio || 1
    W = window.innerWidth || DW
    H = window.innerHeight || DH
    sx = W / DW
    sy = H / DH
    for (const c of [stage, dbgCanvas]) {
      c.width = Math.round(W * dpr)
      c.height = Math.round(H * dpr)
      c.style.width = W + 'px'
      c.style.height = H + 'px'
    }
    window.Characters.setCanvasHeight(DH)
  }
  window.addEventListener('resize', resize)
  resize()

  // ---------------------------------------------------------------- 背景（调试/截图用）

  function drawBackground() {
    if (BG === 'none') return
    if (BG === 'checker') {
      const s = 12
      for (let y = 0; y < DH; y += s) {
        for (let x = 0; x < DW; x += s) {
          const on = ((x / s) | 0) % 2 === ((y / s) | 0) % 2
          ctx.fillStyle = on ? '#e9edf4' : '#d3dae6'
          ctx.fillRect(x, y, s, s)
        }
      }
    } else if (BG === 'dark') {
      ctx.fillStyle = '#171c26'
      ctx.fillRect(0, 0, DW, DH)
    } else if (BG === 'screen') {
      ctx.fillStyle = '#1b2231'
      ctx.fillRect(0, 0, DW, DH)
      ctx.fillStyle = '#10141d'
      ctx.fillRect(0, DH - 40, DW, 40)
    }
  }

  // ---------------------------------------------------------------- 鼠标

  const pointer = { x: DW / 2, y: DH - 60, inside: false }
  let ignoring = true
  let uiOpen = false

  const toDesign = (cx, cy) => ({ x: cx / sx, y: cy / sy })

  /** 命中测试：鼠标在角色身上（或输入框开着）才取消穿透，否则让给桌面 */
  function hitTest(px, py) {
    const pad = 8
    for (const s of character.hit(rig)) {
      const dx = (px - s.x) / (s.rx + pad)
      const dy = (py - s.y) / (s.ry + pad)
      if (dx * dx + dy * dy <= 1) return true
    }
    return false
  }

  let hitState = null
  function updateHit(px, py) {
    const hit = uiOpen || hitTest(px, py)
    if (hit !== hitState) {
      hitState = hit
      ignoring = !hit
      window.companion.setIgnoreMouse(ignoring)
      stage.style.cursor = hit ? 'grab' : 'default'
    }
  }

  function lookAt(px, py) {
    const head = character.headPoint ? character.headPoint(rig) : { x: 180, y: 300 }
    const dx = px - head.x
    const dy = py - head.y
    rig.setLook(clamp(dx / 170, -1, 1), clamp(dy / 190, -1, 1))
  }

  window.addEventListener('mousemove', (e) => {
    const p = toDesign(e.clientX, e.clientY)
    pointer.x = p.x
    pointer.y = p.y
    pointer.inside = true
    lookAt(p.x, p.y)
    updateHit(p.x, p.y)
  })

  window.addEventListener('mouseleave', () => {
    pointer.inside = false
    if (!uiOpen && hitState !== false) {
      hitState = false
      ignoring = true
      window.companion.setIgnoreMouse(true)
    }
  })

  if (window.companion.onCursor) {
    window.companion.onCursor((p) => {
      if (pointer.inside) return
      lookAt(p.x, p.y)
    })
  }

  // ---------------------------------------------------------------- 拖动 / 点击

  let pressAt = null
  let dragging = false

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (e.target === composerInput || e.target === composerSend) return
    const p = toDesign(e.clientX, e.clientY)
    if (!hitTest(p.x, p.y)) return
    pressAt = { x: e.clientX, y: e.clientY }
    dragging = false
    stage.style.cursor = 'grabbing'
  })

  window.addEventListener('mousemove', (e) => {
    if (!pressAt || dragging) return
    if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 5) {
      dragging = true
      window.companion.dragStart()
    }
  })

  window.addEventListener('mouseup', (e) => {
    if (!pressAt) return
    stage.style.cursor = hitState ? 'grab' : 'default'
    if (dragging) {
      window.companion.dragEnd()
    } else if (e.button === 0) {
      onClick()
    }
    pressAt = null
    dragging = false
  })

  function onClick() {
    if (uiOpen) return closeComposer()
    openComposer()
  }

  // ---------------------------------------------------------------- 气泡

  let bubbleTimer = null
  let typer = null
  let bubbleGen = 0      // 气泡代次：防止上一轮的延时关闭误杀新气泡
  let noticeTimer = null

  function bubbleShow() {
    clearTimeout(bubbleTimer)
    clearInterval(typer)
    bubbleGen++
    bubble.classList.remove('hidden')
    bubble.classList.add('show')
  }

  /** 延迟关闭，但如果期间又开了新气泡，这次关闭就作废 */
  function scheduleHide(ms) {
    const gen = bubbleGen
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => {
      if (gen === bubbleGen) hideBubble()
    }, ms)
  }

  /** 逐字打出一条固定文本 */
  function showBubble(text, holdMs) {
    bubbleShow()
    bubbleText.textContent = ''
    bubbleText.classList.add('caret')

    let i = 0
    typer = setInterval(() => {
      i++
      bubbleText.textContent = text.slice(0, i)
      if (i >= text.length) {
        clearInterval(typer)
        bubbleText.classList.remove('caret')
      }
    }, 42)

    if (holdMs) scheduleHide(holdMs)
  }

  /** 流式追加（大脑一边想一边打） */
  function streamBubbleStart() {
    bubbleShow()
    bubbleText.textContent = ''
    bubbleText.classList.add('caret')
  }
  function streamBubbleAppend(t) {
    bubbleText.textContent += t
  }
  function streamBubbleEnd() {
    bubbleText.classList.remove('caret')
  }

  function hideBubble() {
    const gen = bubbleGen
    clearTimeout(bubbleTimer)
    clearInterval(typer)
    bubble.classList.remove('show')
    bubbleText.classList.remove('caret')
    setTimeout(() => {
      if (gen === bubbleGen) bubble.classList.add('hidden')
    }, 200)
  }

  // ---------------------------------------------------------------- 输入条

  function openComposer() {
    uiOpen = true
    clearTimeout(noticeTimer)   // 开场提示别盖在输入条上
    hideBubble()
    composer.classList.remove('hidden')
    window.companion.focusWindow()
    window.companion.setIgnoreMouse(false)
    setTimeout(() => composerInput.focus(), 30)
  }

  function closeComposer() {
    uiOpen = false
    composer.classList.add('hidden')
    composerInput.value = ''
    updateHit(pointer.x, pointer.y)
  }

  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      submitComposer()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeComposer()
    }
    e.stopPropagation()
  })

  composerSend.addEventListener('click', (e) => {
    e.stopPropagation()
    submitComposer()
  })

  function submitComposer() {
    const text = composerInput.value.trim()
    if (!text) return
    closeComposer()
    sendToBrain(text)
  }

  // ---------------------------------------------------------------- 音频 / 口型

  let audioCtx = null
  let analyser = null
  let freqData = null
  let currentAudio = null
  let speakAbort = false
  let ttsWorks = true

  function ensureAudio() {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    return audioCtx
  }

  async function playMp3(bytes) {
    const ac = ensureAudio()
    const blob = new Blob([bytes], { type: 'audio/mpeg' })
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio

    const src = ac.createMediaElementSource(audio)
    analyser = ac.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.55
    freqData = new Uint8Array(analyser.frequencyBinCount)
    src.connect(analyser)
    analyser.connect(ac.destination)

    const started = performance.now()
    // 硬超时：音频卡住不结束（设备被抢、解码器僵死）时不能无限等。
    // 按 48kbps 估时长，再加 8 秒余量。
    const budget = Math.min(45000, Math.round((bytes.length * 8) / 48000 * 1000) + 8000)
    let timer = null

    await new Promise((resolve) => {
      const finish = () => {
        if (timer) clearTimeout(timer)
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
        resolve()
      }
      timer = setTimeout(finish, budget)
      audio.onended = finish
      audio.onerror = finish
      audio.play().catch(finish)
    })

    analyser = null
    // 没有音频设备时 play() 会「瞬间结束」：几个字节的音频不可能 120ms 就放完，
    // 认出来就交给上层按字数等待，免得整轮对话一秒结束。
    if (performance.now() - started < 120 && bytes.length > 4000) {
      throw new Error('这个环境放不出声音')
    }
  }

  function stopSpeaking() {
    speakAbort = true
    if (currentAudio) {
      try { currentAudio.pause() } catch { /* 已经停了 */ }
      currentAudio = null
    }
    analyser = null
    rig.speakLevel = 0
  }

  function splitSentences(text) {
    const raw = String(text)
      .split(/(?<=[。！？!?…\n])/)
      .map((s) => s.trim())
      .filter(Boolean)
    const out = []
    for (const p of raw) {
      if (out.length && out[out.length - 1].length + p.length < 26) out[out.length - 1] += p
      else out.push(p)
    }
    return out.length ? out : [String(text)]
  }

  /** 逐句合成、逐句播放；合成失败就只留气泡，按字数假装读完 */
  async function speakAll(text) {
    speakAbort = false
    rig.setState('speaking')

    const startedAt = Date.now()
    const HARD_LIMIT = 60000   // 整轮发声的上限，防止任何一环卡住把状态锁死

    const parts = splitSentences(text)
    for (const part of parts) {
      if (speakAbort) break
      if (Date.now() - startedAt > HARD_LIMIT) {
        console.warn('[speak] 超过硬上限，强制收尾')
        break
      }
      let bytes = null
      if (ttsWorks) {
        try { bytes = await window.companion.tts(part) } catch { bytes = null }
        if (!bytes || !bytes.length) {
          ttsWorks = false
          console.warn('[tts] 没拿到音频，转静音模式')
        }
      }
      if (speakAbort) break
      if (bytes && bytes.length) {
        try {
          await playMp3(bytes)
        } catch (e) {
          // 没有音频设备 / 解码失败：退化成按字数等待，别把状态卡死
          console.warn('[audio]', e && e.message)
          ttsWorks = false
          await sleep(clamp(part.length * 90, 500, 2600))
        }
      } else {
        await sleep(clamp(part.length * 90, 500, 2600))
      }
    }

    analyser = null
    rig.speakLevel = 0
    if (!speakAbort) {
      rig.setState('idle')
      scheduleHide(1100)
    }
  }

  // ---------------------------------------------------------------- 大脑

  let streaming = false
  let streamedText = ''
  let streamStartedAt = 0
  let brainInfo = null

  async function sendToBrain(text) {
    if (streaming) {
      // 正常忙碌就挡住；但如果是上一次没收到 done/error 卡住了，
      // 30 秒后强制复位，不然她就彻底"聋"了 —— 只能重启。
      if (Date.now() - streamStartedAt < 30000) return
      console.warn('[chat] 上一次没有正常结束，强制复位')
      streaming = false
    }
    streaming = true
    streamStartedAt = Date.now()
    streamedText = ''
    clearTimeout(noticeTimer)
    stopSpeaking()
    speakAbort = false

    console.warn('[chat] 发问:', text)
    rig.setState('thinking')
    streamBubbleStart()

    try {
      const res = await window.companion.chat(text)
      if (res && res.muted) {
        // 用户说了「嘘」，主进程已经闭麦，这里只回一句短话，不配音
        streamBubbleEnd()
        bubbleText.textContent = '好，今天不说了。'
        rig.setState('idle')
        streaming = false
        scheduleHide(2200)
        return
      }
      if (!res || !res.ok) {
        if (res && res.error === 'busy') {
          streamBubbleEnd()
          bubbleText.textContent = '等一下，我还在想上一句。'
        } else {
          streamBubbleEnd()
          bubbleText.textContent = '脑子卡住了：' + ((res && res.error) || '未知错误')
          rig.setState('idle')
        }
        streaming = false
        scheduleHide(3000)
        return
      }
    } catch (e) {
      streamBubbleEnd()
      bubbleText.textContent = '接不上大脑：' + e.message
      rig.setState('idle')
      streaming = false
      scheduleHide(3000)
    }
  }

  if (window.companion.onChatDelta) {
    window.companion.onChatDelta((delta) => {
      if (!streaming) return
      if (!streamedText) rig.setState('speaking')
      streamedText += delta
      streamBubbleAppend(delta)
    })

    window.companion.onChatDone(() => {
      streaming = false
      streamBubbleEnd()
      console.warn('[chat] 收回:', streamedText)
      if (!streamedText.trim()) {
        bubbleText.textContent = '……'
        rig.setState('idle')
        scheduleHide(1600)
        return
      }
      speakAll(streamedText)
    })

    window.companion.onChatError((msg) => {
      streaming = false
      streamBubbleEnd()
      bubbleText.textContent = '出错了：' + msg
      rig.setState('idle')
      scheduleHide(3500)
    })
  }

  if (window.companion.onInputToggle) {
    window.companion.onInputToggle(() => {
      if (uiOpen) closeComposer()
      else openComposer()
    })
  }

  // 自检模式：让主进程替我发一句话，走完整条链路
  if (window.companion.onAutoChat) {
    window.companion.onAutoChat((text) => sendToBrain(text))
  }

  // ---------------------------------------------------------------- 记忆

  if (window.companion.onGreeting) {
    window.companion.onGreeting((text) => {
      if (streaming || uiOpen) return
      rig.setState('listening')
      showBubble(text, 7000)
      setTimeout(() => {
        if (rig.state === 'listening') rig.setState('idle')
      }, 7200)
    })
  }

  if (window.companion.onMemoryCleared) {
    window.companion.onMemoryCleared(() => {
      showBubble('好，忘干净了。', 2600)
    })
  }

  // ---------------------------------------------------------------- 主动开口

  if (window.companion.onProactiveSay) {
    window.companion.onProactiveSay((text) => {
      if (streaming || uiOpen) return
      showBubble(text, 0)
      speakAll(text)
    })
  }

  if (window.companion.onProactiveMuted) {
    window.companion.onProactiveMuted(() => {
      showBubble('好，今天不说了。', 2400)
    })
  }

  // ---------------------------------------------------------------- PTT

  let replyTimer = null

  // ---------------------------------------------------------------- 麦克风

  const mic = {
    stream: null, ctx: null, node: null, src: null,
    analyser: null, time: null, chunks: [], active: false, failed: false,
  }

  async function ensureMic() {
    if (mic.stream) return true
    if (mic.failed) return false
    try {
      mic.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      mic.ctx = new AudioContext({ sampleRate: 16000 })
      mic.src = mic.ctx.createMediaStreamSource(mic.stream)
      mic.analyser = mic.ctx.createAnalyser()
      mic.analyser.fftSize = 512
      mic.time = new Uint8Array(mic.analyser.fftSize)

      // ScriptProcessor 已经过时，但它是这里最省事的采集方式；
      // 接一个 gain=0 的节点到 destination 才能让处理链跑起来，且不会外放。
      mic.node = mic.ctx.createScriptProcessor(4096, 1, 1)
      mic.node.onaudioprocess = (e) => {
        if (!mic.active) return
        mic.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      const mute = mic.ctx.createGain()
      mute.gain.value = 0
      mic.src.connect(mic.analyser)
      mic.src.connect(mic.node)
      mic.node.connect(mute)
      mute.connect(mic.ctx.destination)
      console.warn('[mic] 就绪', mic.ctx.sampleRate, 'Hz')
      return true
    } catch (e) {
      mic.failed = true
      console.warn('[mic] 打不开:', e.message)
      return false
    }
  }

  function startMic() {
    mic.chunks = []
    mic.active = true
    if (mic.ctx && mic.ctx.state === 'suspended') mic.ctx.resume()
  }

  function stopMic() {
    mic.active = false
    const total = mic.chunks.reduce((a, c) => a + c.length, 0)
    if (!total) return new Float32Array(0)
    const out = new Float32Array(total)
    let o = 0
    for (const c of mic.chunks) { out.set(c, o); o += c.length }
    mic.chunks = []
    return out
  }

  if (window.companion.onPttStart) {
    window.companion.onPttStart(async () => {
      clearTimeout(replyTimer)
      stopSpeaking()
      hideBubble()

      const ok = await ensureMic()
      if (!ok) {
        showBubble('麦克风打不开。看看 Windows 设置里的麦克风权限？', 3200)
        return
      }
      startMic()
      rig.setState('listening')
      showBubble('（在听…）', 0)
    })

    window.companion.onPttStop(async () => {
      if (rig.state !== 'listening') return
      handleUtterance(stopMic())
    })
  }

  /** 一段录音 → 识别 → 送进大脑。麦克风和自检走同一条路。 */
  async function handleUtterance(samples) {
    if (!samples || samples.length < 16000 * 0.3) {
      rig.setState('idle')
      hideBubble()
      showBubble('太短了。多按一会儿再松。', 1800)
      return
    }

    rig.setState('thinking')
    showBubble('…', 0)

    let r = null
    try {
      r = await window.companion.transcribe(samples)
    } catch (e) {
      r = { ok: false, error: e.message }
    }

    if (r && r.ok && r.text) {
      console.warn('[asr]', r.text, `(${r.ms}ms)`)
      sendToBrain(r.text)
    } else {
      rig.setState('idle')
      hideBubble()
      showBubble(`没听清（${(r && r.error) || '未知'}）。打字吧。`, 2400)
      setTimeout(openComposer, 500)
    }
  }

  // 自检：主进程塞一段 wav 进来，走完整条识别链路（不需要麦克风）
  if (window.companion.onSimVoice) {
    window.companion.onSimVoice((payload) => {
      // 主进程送来的是 Float32 小端字节流
      const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
      const aligned = new Uint8Array(u8.byteLength)
      aligned.set(u8)
      const samples = new Float32Array(aligned.buffer)
      console.warn('[sim] 收到语音样本', samples.length)
      handleUtterance(samples)
    })
  }

  // ---------------------------------------------------------------- 循环

  let last = performance.now()

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now

    // 音频包络 → 口型
    if (analyser && freqData) {
      analyser.getByteFrequencyData(freqData)
      let sum = 0
      for (let i = 0; i < freqData.length; i++) {
        const v = freqData[i] / 255
        sum += v * v
      }
      const rms = Math.sqrt(sum / freqData.length)
      rig.speakLevel = lerp(rig.speakLevel, clamp(rms * 2.6, 0, 1), 0.45)
    } else {
      rig.speakLevel = lerp(rig.speakLevel, 0, 0.2)
    }

    // 麦克风电平 → 聆听光晕
    if (mic.active && mic.analyser && mic.time) {
      mic.analyser.getByteTimeDomainData(mic.time)
      let sum = 0
      for (let i = 0; i < mic.time.length; i++) {
        const v = (mic.time[i] - 128) / 128
        sum += v * v
      }
      const lvl = Math.sqrt(sum / mic.time.length)
      rig.listenLevel = lerp(rig.listenLevel, clamp(lvl * 5.5, 0, 1), 0.35)
    } else {
      rig.listenLevel = lerp(rig.listenLevel, 0, 0.15)
    }

    rig.update(dt)

    ctx.setTransform(dpr * sx, 0, 0, dpr * sy, 0, 0)
    ctx.clearRect(0, 0, DW, DH)
    drawBackground()
    drawHalo(ctx, rig)
    character.draw(ctx, rig)

    if (DEBUG) drawDebug()

    requestAnimationFrame(frame)
  }

  /** 聆听/说话时的光晕，画在角色背后。三种画法共用，所以放在这里。 */
  function drawHalo(ctx, rig) {
    const lvl = Math.min(1, (rig.glow.value || 0) * 0.55 + (rig.listenLevel || 0) * 0.85)
    if (lvl < 0.02) return
    const hp = character.headPoint ? character.headPoint(rig) : { x: 180, y: 300 }
    const r = 140 + lvl * 70
    const g = ctx.createRadialGradient(hp.x, hp.y, 8, hp.x, hp.y, r)
    g.addColorStop(0, `rgba(130, 205, 255, ${0.26 * lvl})`)
    g.addColorStop(0.55, `rgba(110, 180, 255, ${0.12 * lvl})`)
    g.addColorStop(1, 'rgba(110, 180, 255, 0)')
    ctx.save()
    ctx.beginPath()
    ctx.arc(hp.x, hp.y, r, 0, Math.PI * 2)
    ctx.fillStyle = g
    ctx.fill()
    ctx.restore()
  }

  function drawDebug() {
    dctx.setTransform(dpr * sx, 0, 0, dpr * sy, 0, 0)
    dctx.clearRect(0, 0, DW, DH)
    dctx.lineWidth = 1.5
    for (const s of character.hit(rig)) {
      dctx.beginPath()
      dctx.ellipse(s.x, s.y, s.rx + 8, s.ry + 8, 0, 0, Math.PI * 2)
      dctx.strokeStyle = 'rgba(80, 220, 140, 0.85)'
      dctx.stroke()
    }
    dctx.fillStyle = 'rgba(255,255,255,0.85)'
    dctx.font = '12px Consolas, monospace'
    dctx.fillText(
      `state=${rig.state} ignore=${ignoring} eye=${rig.eyeOpen.toFixed(2)} mouth=${rig.mouthOpen.toFixed(2)}`,
      8, 16
    )
  }

  // ---------------------------------------------------------------- 资产

  async function loadCharacter() {
    try {
      const a = await window.companion.assets()
      if (a.mode === 'layered') {
        character = new window.Characters.LayeredCharacter(a.manifest, a.dir)
      } else if (a.mode === 'single') {
        await new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => {
            character = new window.Characters.ImageCharacter(img, { canvasH: DH })
            resolve()
          }
          img.onerror = reject
          img.src = a.url
        })
      }
    } catch (e) {
      console.warn('[assets] 回退到占位角色', e)
    }
  }

  // ---------------------------------------------------------------- 启动

  if (FORCE_STATE) {
    rig.setState(FORCE_STATE)
    if (FORCE_STATE === 'speaking') {
      showBubble('这张图我可以帮你拆成十层，头发、眼睛、嘴都能单独动。', 0)
    }
  }

  if (window.companion.onState) {
    window.companion.onState((s) => {
      rig.setState(s)
      if (s === 'speaking') showBubble('这张图我可以帮你拆成十层，头发、眼睛、嘴都能单独动。', 0)
      else if (s === 'listening') showBubble('嗯，我在听。', 0)
      else if (s === 'thinking') showBubble('…', 0)
      else hideBubble()
    })
  }

  // 首次启动提示：大脑是假的，说清楚
  window.companion.chatInfo().then((info) => {
    brainInfo = info
    if (info.mock) {
      noticeTimer = setTimeout(() => {
        // 期间已经有过别的气泡（问候、主动开口、对话），就别再插一句
        if (bubbleGen > 0 || streaming || streamedText) return
        showBubble('大脑还没接上（config.json 填个 key 就行）。先打字陪我聊两句？', 5200)
      }, 1400)
    }
  }).catch(() => {})

  window.__comp = {
    rig,
    get character() { return character },
    showBubble, hideBubble, openComposer, closeComposer, sendToBrain,
    look: (x, y) => rig.setLook(x, y),
    get info() { return brainInfo },
  }

  loadCharacter().then(() => requestAnimationFrame(frame))
  requestAnimationFrame(frame)
})()
