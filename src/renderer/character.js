/**
 * character.js —— 画角色
 *
 * 三种模式，接口一致（draw / hit）：
 *   placeholder  没有图时的程序化占位小人（能呼吸、眨眼、头发会晃）
 *   single        assets/character/base.png 单图，带呼吸/漂浮/视差
 *   layered       assets/character/manifest.json 整画布分层 PNG，逐层视差 + 弹簧
 *
 * 换图不用改这里：把文件丢进 assets/character/ 就行。
 */
(function () {
  'use strict'

  const CX = 180
  const GROUND = 462

  // 画布高度可变：窗口为了给气泡留地方，做成了竖长条。
  // 占位小人内部坐标是按 480 高写的，统一靠 DY 往下挪。
  let CH = 480
  function setCanvasHeight(h) { CH = h || 480 }
  const DY = () => CH - 480

  // ------------------------------------------------------------ 调色
  const C = {
    line: '#2b3348',
    hairTop: '#f4f8ff',
    hairBot: '#c6d6ec',
    hairShade: '#aec2dd',
    skin: '#ffe6da',
    skinShade: '#f7c8ba',
    dressTop: '#4d5c7c',
    dressBot: '#2f3a54',
    eyeTop: '#22375f',
    eyeBot: '#5590e0',
    eyeLine: '#2b3348',
    blush: 'rgba(255, 148, 148, 0.28)',
    rim: 'rgba(205, 233, 255, 0.95)',
  }

  const rnd = (a, b) => a + Math.random() * (b - a)
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

  function ellipse(ctx, x, y, rx, ry, rot) {
    ctx.beginPath()
    ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, Math.PI * 2)
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr)
    ctx.arcTo(x + w, y + h, x, y + h, rr)
    ctx.arcTo(x, y + h, x, y, rr)
    ctx.arcTo(x, y, x + w, y, rr)
    ctx.closePath()
  }

  function paint(ctx, doFill, doStroke, width) {
    if (doFill) ctx.fill()
    if (doStroke) {
      ctx.lineWidth = width || 2.2
      ctx.strokeStyle = C.line
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.stroke()
    }
  }

  // ============================================================ 占位角色

  class PlaceholderCharacter {
    constructor() {
      this.name = 'placeholder'
    }

    // ---------------- 各部件 ----------------

    drawShadow(ctx, rig) {
      const lift = clamp(rig.floatY / 6, 0, 1)
      const rx = 62 - lift * 8
      const ry = 10 - lift * 1.2
      const g = ctx.createRadialGradient(CX, GROUND + 1, 0, CX, GROUND + 1, rx)
      g.addColorStop(0, 'rgba(22, 30, 50, 0.46)')
      g.addColorStop(0.45, 'rgba(22, 30, 50, 0.24)')
      g.addColorStop(1, 'rgba(22, 30, 50, 0)')
      ctx.save()
      ctx.translate(CX, GROUND + 1)
      ctx.scale(1, ry / rx)
      ctx.beginPath()
      ctx.arc(0, 0, rx, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()
      ctx.restore()
    }

    drawHairBack(ctx, rig) {
      const sway = rig.hairX.value * 0.5
      ctx.save()
      ctx.translate(sway, 0)

      // 后发要比前发暗一档，否则整颗头会糊成一个白头盔
      const g = ctx.createLinearGradient(CX, 214, CX, 420)
      g.addColorStop(0, '#cddbf0')
      g.addColorStop(0.45, '#b0c4e0')
      g.addColorStop(1, '#8fa5c6')

      ctx.beginPath()
      ctx.moveTo(CX - 58, 300)
      ctx.bezierCurveTo(CX - 67, 238, CX - 32, 214, CX, 214)
      ctx.bezierCurveTo(CX + 32, 214, CX + 67, 238, CX + 58, 300)
      ctx.bezierCurveTo(CX + 58, 344, CX + 47, 384, CX + 35, 402)
      ctx.quadraticCurveTo(CX, 414, CX - 35, 402)
      ctx.bezierCurveTo(CX - 47, 384, CX - 58, 344, CX - 58, 300)
      ctx.closePath()
      ctx.fillStyle = g
      paint(ctx, true, true, 2.4)

      // 内侧暗部，让后发有厚度
      ctx.save()
      ctx.globalAlpha = 0.30
      ellipse(ctx, CX, 334, 44, 68)
      ctx.fillStyle = '#7b91b3'
      ctx.fill()
      ctx.restore()

      ctx.restore()
    }

    drawLegs(ctx, rig) {
      const skin = ctx.createLinearGradient(CX, 440, CX, 468)
      skin.addColorStop(0, C.skinShade)
      skin.addColorStop(1, C.skin)

      for (const dx of [-15, 15]) {
        roundRect(ctx, CX + dx - 8, 434, 16, 24, 8)
        ctx.fillStyle = skin
        paint(ctx, true, true, 2)
        // 鞋
        roundRect(ctx, CX + dx - 10, 448, 20, 13, 6)
        ctx.fillStyle = C.dressBot
        paint(ctx, true, true, 2)
      }
    }

    armAngle(rig) {
      // 聆听时手臂微微抬起，像在认真听
      const lift = rig.lean.value
      return -0.62 * Math.max(0, lift)
    }

    drawBody(ctx, rig) {
      const g = ctx.createLinearGradient(CX, 360, CX, 466)
      g.addColorStop(0, C.dressTop)
      g.addColorStop(1, C.dressBot)

      // 裙子
      ctx.beginPath()
      ctx.moveTo(CX - 34, 366)
      ctx.quadraticCurveTo(CX - 17, 357, CX, 357)
      ctx.quadraticCurveTo(CX + 17, 357, CX + 34, 366)
      ctx.bezierCurveTo(CX + 48, 400, CX + 58, 424, CX + 60, 442)
      ctx.quadraticCurveTo(CX, 452, CX - 60, 442)
      ctx.bezierCurveTo(CX - 58, 424, CX - 48, 400, CX - 34, 366)
      ctx.closePath()
      ctx.fillStyle = g
      paint(ctx, true, true, 2.4)

      // 胸前亮面
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      ctx.moveTo(CX - 15, 366)
      ctx.quadraticCurveTo(CX, 359, CX + 15, 366)
      ctx.bezierCurveTo(CX + 21, 396, CX + 26, 418, CX + 27, 438)
      ctx.quadraticCurveTo(CX, 445, CX - 27, 438)
      ctx.bezierCurveTo(CX - 26, 418, CX - 21, 396, CX - 15, 366)
      ctx.closePath()
      ctx.fillStyle = '#6a7ba0'
      ctx.fill()
      ctx.restore()

      // 领口
      ctx.beginPath()
      ctx.moveTo(CX - 13, 360)
      ctx.quadraticCurveTo(CX, 370, CX + 13, 360)
      ctx.quadraticCurveTo(CX, 356, CX - 13, 360)
      ctx.closePath()
      ctx.fillStyle = '#ffffff'
      paint(ctx, true, true, 1.8)

      // 扣子
      ctx.fillStyle = '#ffd76a'
      for (const y of [392, 410]) {
        ellipse(ctx, CX, y, 2.4, 2.4)
        ctx.fill()
      }

      // 领结：全画面唯一一处暖色，视线会先落在它上面
      ctx.beginPath()
      ctx.moveTo(CX, 372)
      ctx.lineTo(CX - 13, 366)
      ctx.quadraticCurveTo(CX - 15, 376, CX - 12, 380)
      ctx.closePath()
      ctx.fillStyle = '#ff8fa3'
      paint(ctx, true, true, 1.8)
      ctx.beginPath()
      ctx.moveTo(CX, 372)
      ctx.lineTo(CX + 13, 366)
      ctx.quadraticCurveTo(CX + 15, 376, CX + 12, 380)
      ctx.closePath()
      paint(ctx, true, true, 1.8)
      ellipse(ctx, CX, 373, 3.4, 4.2)
      ctx.fillStyle = '#ffb3c1'
      paint(ctx, true, true, 1.6)

      // 下摆镶边，让裙子有一点剪裁感
      ctx.beginPath()
      ctx.moveTo(CX - 58, 441)
      ctx.quadraticCurveTo(CX, 451, CX + 58, 441)
      ctx.lineWidth = 3.5
      ctx.strokeStyle = 'rgba(210, 228, 255, 0.30)'
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    drawArms(ctx, rig) {
      const a = this.armAngle(rig)
      const skin = C.skin

      for (const side of [-1, 1]) {
        ctx.save()
        ctx.translate(CX + side * 36, 378)
        ctx.rotate(side * (0.30 - a * 0.95))

        // 袖子
        roundRect(ctx, -9, 0, 18, 46, 9)
        const g = ctx.createLinearGradient(0, 0, 0, 46)
        g.addColorStop(0, C.dressTop)
        g.addColorStop(1, C.dressBot)
        ctx.fillStyle = g
        paint(ctx, true, true, 2)

        // 手
        ellipse(ctx, 0, 50, 9, 8.5)
        ctx.fillStyle = skin
        paint(ctx, true, true, 1.8)
        // 袖口
        ctx.beginPath()
        ctx.moveTo(-8, 43)
        ctx.quadraticCurveTo(0, 47, 8, 43)
        ctx.lineWidth = 1.8
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.stroke()

        ctx.restore()
      }
    }

    drawGlow(ctx, rig) {
      // 聆听时除了状态本身发光，还让光晕跟着你的说话音量一起涨落
      const g0 = Math.min(1, rig.glow.value + (rig.listenLevel || 0) * 0.75)
      if (g0 < 0.02) return
      const r = 96 + (rig.listenLevel || 0) * 34
      const g = ctx.createRadialGradient(CX, 310, 10, CX, 310, r)
      g.addColorStop(0, `rgba(120, 200, 255, ${0.30 * g0})`)
      g.addColorStop(0.6, `rgba(110, 180, 255, ${0.14 * g0})`)
      g.addColorStop(1, 'rgba(110, 180, 255, 0)')
      ctx.save()
      ctx.beginPath()
      ctx.arc(CX, 310, r, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()
      ctx.restore()
    }

    drawFace(ctx, rig) {
      const g = ctx.createLinearGradient(CX, 250, CX, 360)
      g.addColorStop(0, C.skin)
      g.addColorStop(1, C.skinShade)

      // 耳朵（先画，被脸压住一部分）
      for (const side of [-1, 1]) {
        ctx.save()
        ctx.translate(CX + side * 55, 306)
        ctx.rotate(side * 0.15)
        ellipse(ctx, 0, 0, 8, 12)
        ctx.fillStyle = C.skin
        paint(ctx, true, true, 2)
        ctx.restore()
      }

      // 脸
      ctx.beginPath()
      ctx.moveTo(CX - 56, 296)
      ctx.bezierCurveTo(CX - 56, 246, CX - 34, 236, CX, 236)
      ctx.bezierCurveTo(CX + 34, 236, CX + 56, 246, CX + 56, 296)
      ctx.bezierCurveTo(CX + 54, 328, CX + 26, 352, CX, 352)
      ctx.bezierCurveTo(CX - 26, 352, CX - 54, 328, CX - 56, 296)
      ctx.closePath()
      ctx.fillStyle = g
      paint(ctx, true, true, 2.4)

      // 腮红
      for (const side of [-1, 1]) {
        const bg = ctx.createRadialGradient(CX + side * 40, 322, 1, CX + side * 40, 322, 15)
        bg.addColorStop(0, C.blush)
        bg.addColorStop(1, 'rgba(255,148,148,0)')
        ellipse(ctx, CX + side * 40, 322, 15, 8)
        ctx.fillStyle = bg
        ctx.fill()
      }

      // 刘海在额头上投下的一点影子，没有这块脸会显得平
      ctx.save()
      ctx.globalAlpha = 0.13
      ellipse(ctx, CX, 296, 44, 24)
      ctx.fillStyle = '#c98a7c'
      ctx.fill()
      ctx.restore()
    }

    drawEyes(ctx, rig) {
      const open = clamp(rig.eyeOpen, 0.02, 1.15)
      const px = rig.pupil.x
      const py = rig.pupil.y

      for (const side of [-1, 1]) {
        const ex = CX + side * 25
        const ey = 303

        if (open < 0.16) {
          // 闭眼：一条带弧度的线
          ctx.beginPath()
          ctx.moveTo(ex - 12, ey + 2)
          ctx.quadraticCurveTo(ex, ey + 8, ex + 12, ey + 2)
          ctx.lineWidth = 3.6
          ctx.strokeStyle = C.eyeLine
          ctx.lineCap = 'round'
          ctx.stroke()
          continue
        }

        ctx.save()
        ctx.translate(ex, ey)
        ctx.scale(1, open)

        // 眼白
        ellipse(ctx, 0, 0, 15, 17)
        ctx.fillStyle = '#ffffff'
        paint(ctx, true, true, 2)

        // 虹膜
        const ig = ctx.createLinearGradient(0, -16, 0, 16)
        ig.addColorStop(0, C.eyeTop)
        ig.addColorStop(1, C.eyeBot)
        ellipse(ctx, px * 2.4, py * 1.8, 12.4, 14.6)
        ctx.fillStyle = ig
        ctx.fill()

        // 瞳孔
        ellipse(ctx, px * 2.4, py * 1.8 + 1, 5.4, 6.8)
        ctx.fillStyle = '#101a2e'
        ctx.fill()

        // 高光
        ellipse(ctx, px * 2.4 - 4.4, py * 1.8 - 5.4, 4.6, 4.9)
        ctx.fillStyle = 'rgba(255,255,255,0.97)'
        ctx.fill()
        ellipse(ctx, px * 2.4 + 4.6, py * 1.8 + 5.6, 2.3, 2.4)
        ctx.fillStyle = 'rgba(255,255,255,0.7)'
        ctx.fill()

        // 上睫毛：粗弧线，二次元的灵魂
        ctx.beginPath()
        ctx.ellipse(0, 0, 15, 17, 0, Math.PI * 1.06, Math.PI * 1.94)
        ctx.lineWidth = 4.6
        ctx.strokeStyle = C.eyeLine
        ctx.lineCap = 'round'
        ctx.stroke()

        ctx.restore()
      }
    }

    drawMouth(ctx, rig) {
      const mx = CX
      const my = 334
      const o = clamp(rig.mouthOpen, 0, 1) * (rig.eyeOpen > 0.3 ? 1 : 0.3)

      if (o < 0.1) {
        ctx.beginPath()
        ctx.moveTo(mx - 5.5, my)
        ctx.quadraticCurveTo(mx, my + 4.2, mx + 5.5, my)
        ctx.lineWidth = 2.4
        ctx.strokeStyle = '#a9615c'
        ctx.lineCap = 'round'
        ctx.stroke()
        return
      }

      const h = 3 + 13 * o
      const w = 6 + 6 * o
      ctx.beginPath()
      ctx.moveTo(mx - w, my - 1)
      ctx.quadraticCurveTo(mx, my + h * 1.15, mx + w, my - 1)
      ctx.quadraticCurveTo(mx, my + h * 0.25, mx - w, my - 1)
      ctx.closePath()
      ctx.fillStyle = '#8b3f3f'
      paint(ctx, true, true, 1.8)

      // 舌头
      ctx.save()
      ctx.globalAlpha = 0.85
      ellipse(ctx, mx, my + h * 0.62, w * 0.55, h * 0.28)
      ctx.fillStyle = '#e8888a'
      ctx.fill()
      ctx.restore()
    }

    drawFrontHair(ctx, rig) {
      const g = ctx.createLinearGradient(CX, 216, CX, 344)
      g.addColorStop(0, '#f9fcff')
      g.addColorStop(0.5, '#e2ecf9')
      g.addColorStop(1, '#b9cbe2')

      const sway = rig.hairX.value * 0.22
      ctx.save()
      ctx.translate(sway, 0)

      // 一整块「头发外壳」：外缘即头型，下缘除了刘海还包到脸颊两侧，
      // 这样刘海和后发之间没有接缝，不会出现「两顶帽子叠在一起」
      ctx.beginPath()
      ctx.moveTo(CX - 58, 338)
      ctx.bezierCurveTo(CX - 65, 258, CX - 38, 220, CX, 220)
      ctx.bezierCurveTo(CX + 38, 220, CX + 65, 258, CX + 58, 338)
      // 内侧发缘：右鬓角 → 刘海 → 左鬓角
      ctx.quadraticCurveTo(CX + 52, 302, CX + 46, 296)
      ctx.quadraticCurveTo(CX + 40, 272, CX + 29, 291)
      ctx.quadraticCurveTo(CX + 20, 268, CX + 8, 289)
      ctx.quadraticCurveTo(CX - 2, 266, CX - 13, 290)
      ctx.quadraticCurveTo(CX - 24, 270, CX - 33, 293)
      ctx.quadraticCurveTo(CX - 43, 276, CX - 48, 299)
      ctx.quadraticCurveTo(CX - 54, 306, CX - 58, 338)
      ctx.closePath()
      ctx.fillStyle = g
      paint(ctx, true, true, 2.4)

      // 发丝高光
      ctx.save()
      ctx.globalAlpha = 0.6
      ctx.beginPath()
      ctx.moveTo(CX - 38, 250)
      ctx.quadraticCurveTo(CX - 16, 235, CX + 6, 240)
      ctx.lineWidth = 6
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.restore()

      // 刘海边缘的暗部，让它有厚度
      ctx.save()
      ctx.globalAlpha = 0.22
      ctx.beginPath()
      ctx.moveTo(CX - 48, 299)
      ctx.quadraticCurveTo(CX - 43, 276, CX - 33, 293)
      ctx.quadraticCurveTo(CX - 24, 270, CX - 13, 290)
      ctx.quadraticCurveTo(CX - 2, 266, CX + 8, 289)
      ctx.quadraticCurveTo(CX + 20, 268, CX + 29, 291)
      ctx.quadraticCurveTo(CX + 40, 272, CX + 46, 296)
      ctx.lineWidth = 7
      ctx.strokeStyle = '#7f96b8'
      ctx.stroke()
      ctx.restore()

      // 发饰：小星星
      this.drawStar(ctx, CX + 44, 262, 7.5, rig.t * 0.9)

      ctx.restore()
    }

    drawStar(ctx, x, y, r, rot) {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(rot)
      ctx.beginPath()
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i
        const rr = i % 2 === 0 ? r : r * 0.38
        const px = Math.cos(a) * rr
        const py = Math.sin(a) * rr
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
      }
      ctx.closePath()
      ctx.fillStyle = '#ffd76a'
      paint(ctx, true, true, 1.6)
      ctx.restore()
    }

    drawSideLocks(ctx, rig) {
      const g = ctx.createLinearGradient(CX, 264, CX, 372)
      g.addColorStop(0, '#f6faff')
      g.addColorStop(0.55, '#dae6f6')
      g.addColorStop(1, '#a8bdd9')

      const locks = [
        { side: -1, ax: CX - 53, ay: 266, sway: rig.lockL.value },
        { side: 1, ax: CX + 53, ay: 266, sway: rig.lockR.value },
      ]

      for (const L of locks) {
        ctx.save()
        ctx.translate(L.ax, L.ay)
        ctx.rotate(L.side * L.sway * 0.012)

        // 窄、带弧度、尖端收细 —— 宽了就会变成窗帘
        ctx.beginPath()
        ctx.moveTo(-9, -2)
        ctx.bezierCurveTo(-13, 30, -12, 60, -6, 84)
        ctx.quadraticCurveTo(-1, 94, 4, 84)
        ctx.bezierCurveTo(8, 56, 9, 24, 10, -2)
        ctx.closePath()
        ctx.fillStyle = g
        paint(ctx, true, true, 2.2)

        // 内侧一道暗线，和脸颊拉开层次
        ctx.beginPath()
        ctx.moveTo(-6, 6)
        ctx.bezierCurveTo(-9, 34, -8, 58, -4, 76)
        ctx.lineWidth = 1.4
        ctx.strokeStyle = 'rgba(130, 152, 184, 0.55)'
        ctx.stroke()

        ctx.restore()
      }
    }

    drawAhoge(ctx, rig) {
      // 一条细发丝，不是角：用描边画，根部藏在头发里就不会有接缝
      const sway = rig.ahoge.value * 0.6
      const bx = CX + 4
      const by = 244
      const tx = CX + 27 + sway
      const ty = 205
      const c1x = CX + 1 + sway * 0.25
      const c1y = 220
      const c2x = CX + 17 + sway * 0.7
      const c2y = 197

      const strand = () => {
        ctx.beginPath()
        ctx.moveTo(bx, by)
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, tx, ty)
        ctx.lineCap = 'round'
      }

      strand()
      ctx.lineWidth = 7
      ctx.strokeStyle = C.line
      ctx.stroke()

      strand()
      ctx.lineWidth = 3.6
      ctx.strokeStyle = '#dce8f7'
      ctx.stroke()
    }

    drawRim(ctx, rig) {
      const a = 0.9
      ctx.save()
      ctx.globalAlpha = a
      ctx.lineCap = 'round'

      // 头发左缘的轮廓光
      ctx.beginPath()
      ctx.moveTo(CX - 52, 296)
      ctx.bezierCurveTo(CX - 58, 258, CX - 40, 236, CX - 18, 230)
      ctx.lineWidth = 2
      ctx.strokeStyle = C.rim
      ctx.stroke()

      // 脸颊左侧
      ctx.beginPath()
      ctx.moveTo(CX - 54, 300)
      ctx.bezierCurveTo(CX - 52, 322, CX - 40, 340, CX - 28, 348)
      ctx.lineWidth = 1.6
      ctx.strokeStyle = 'rgba(220,240,255,0.55)'
      ctx.stroke()

      // 裙子左侧
      ctx.beginPath()
      ctx.moveTo(CX - 32, 372)
      ctx.bezierCurveTo(CX - 46, 404, CX - 54, 434, CX - 55, 450)
      ctx.lineWidth = 1.6
      ctx.strokeStyle = 'rgba(200,225,255,0.35)'
      ctx.stroke()

      ctx.restore()
    }

    // ---------------- 主绘制 ----------------

    draw(ctx, rig) {
      const dy = DY()
      ctx.save()
      ctx.translate(0, dy)

      this.drawShadow(ctx, rig)

      ctx.save()
      // 漂浮
      ctx.translate(0, -rig.floatY)
      // 呼吸：以脚底为原点做轻微缩放
      ctx.translate(CX, GROUND)
      ctx.scale(1 - rig.breath * 0.006, 1 + rig.breath * 0.012)
      ctx.translate(-CX, -GROUND)

      this.drawHairBack(ctx, rig)
      this.drawLegs(ctx, rig)
      this.drawBody(ctx, rig)
      this.drawGlow(ctx, rig)

      // 头部整体跟随
      ctx.save()
      ctx.translate(CX + rig.headX.value, 352 + rig.headY.value)
      ctx.rotate(rig.tilt.value * 0.12)
      ctx.translate(-CX, -352)

      this.drawFace(ctx, rig)
      this.drawFrontHair(ctx, rig)
      this.drawEyes(ctx, rig)
      this.drawMouth(ctx, rig)

      ctx.restore()

      // 呆毛用独立弹簧，画在头之外（它要滞后）
      this.drawAhoge(ctx, rig)
      this.drawRim(ctx, rig)

      ctx.restore()
      ctx.restore()
    }

    hit(rig) {
      const dy = DY()
      const hx = CX + rig.headX.value
      const hy = 296 + rig.headY.value + dy
      return [
        { x: hx, y: hy, rx: 62, ry: 60 },              // 头
        { x: CX + rig.headX.value * 0.4, y: 408 + dy, rx: 46, ry: 56 }, // 身体
      ]
    }

    headPoint(rig) {
      return { x: CX + rig.headX.value, y: 296 + rig.headY.value + DY() }
    }
  }

  // ============================================================ 单图

  class ImageCharacter {
    /**
     * 单张透明 PNG（半身像专用）。
     * 关键：底边压到窗口下沿之外一点，让「腰被切断」的那条线藏进任务栏后面。
     */
    constructor(img, opts = {}) {
      this.img = img
      this.name = 'single'
      this.ch = opts.canvasH || CH

      // 头顶要留出气泡的位置
      const headroom = opts.headroom ?? 196
      const maxH = Math.max(200, this.ch - headroom)
      const maxW = opts.maxWidth ?? 328
      this.scale = Math.min(maxH / img.height, maxW / img.width)
      this.w = Math.round(img.width * this.scale)
      this.h = Math.round(img.height * this.scale)
      this.bottom = this.ch + 10
    }

    draw(ctx, rig) {
      const lift = rig.floatY * 0.55          // 半身像不适合飘太多，会像贴纸
      const bx = CX + rig.headX.value * 0.42
      const by = this.bottom - this.h - lift

      ctx.save()
      // 呼吸：以底边中点为支点，胸口起伏，头不动
      ctx.translate(CX, this.bottom)
      ctx.scale(1 - rig.breath * 0.004, 1 + rig.breath * 0.009)
      ctx.rotate(rig.tilt.value * 0.008 + rig.headX.value * 0.0006)
      ctx.translate(-CX, -this.bottom)

      ctx.globalAlpha = 0.995
      // 外阴影：浅色壁纸上白色头发会糊掉，靠一层很淡的暗边把轮廓托出来。
      // 半径不能大，大了就是一圈灰雾，等于给她加了个脏边。
      ctx.shadowColor = 'rgba(10, 16, 28, 0.30)'
      ctx.shadowBlur = 9
      ctx.shadowOffsetY = 3
      ctx.drawImage(this.img, Math.round(bx - this.w / 2), Math.round(by), this.w, this.h)
      ctx.restore()
    }

    hit() {
      const top = this.bottom - this.h
      return [
        { x: CX, y: top + this.h * 0.15, rx: this.w * 0.34, ry: this.h * 0.14 },  // 头
        { x: CX, y: top + this.h * 0.62, rx: this.w * 0.42, ry: this.h * 0.32 },  // 身
      ]
    }

    headPoint() {
      return { x: CX, y: this.bottom - this.h + this.h * 0.15 }
    }
  }

  // ============================================================ 分层

  class LayeredCharacter {
    /**
     * manifest: {
     *   canvas: { width, height },           // 所有图层共用的整画布尺寸
     *   fit:   { height: 320, bottom: 470 }, // 在 360x480 窗口里怎么摆
     *   layers: [{ file, parallax, sway, tilt }]
     * }
     */
    constructor(manifest, baseUrl) {
      this.name = 'layered'
      this.m = manifest
      const cv = manifest.canvas || { width: 1000, height: 1600 }
      const fit = manifest.fit || { height: Math.min(320, CH - 200), bottom: CH + 10 }
      this.fit = fit
      this.scale = fit.height / cv.height
      this.baseW = cv.width * this.scale
      this.baseH = cv.height * this.scale
      this.baseX = CX - this.baseW / 2
      this.baseY = fit.bottom - this.baseH

      this.layers = (manifest.layers || []).map((l) => ({
        def: l,
        img: null,
        url: baseUrl.replace(/\/$/, '') + '/' + l.file,
      }))
      this.ready = false
      this.loadAll()
    }

    loadAll() {
      let left = this.layers.length
      if (!left) { this.ready = true; return }
      for (const L of this.layers) {
        const img = new Image()
        img.onload = () => { L.img = img; if (--left === 0) this.ready = true }
        img.onerror = () => { console.warn('[layer] 加载失败', L.url); if (--left === 0) this.ready = true }
        img.src = L.url
      }
    }

    draw(ctx, rig) {
      if (!this.ready) return
      const bottom = this.baseY + this.baseH
      const bx = this.baseX

      // 影子（除非 manifest 明确关掉，或者自带 shadow 层）
      if (this.m.shadow !== false && !this.layers.some((l) => /shadow/i.test(l.def.file))) {
        const rx = this.baseW * 0.32
        const g = ctx.createRadialGradient(CX, bottom, 0, CX, bottom, rx)
        g.addColorStop(0, 'rgba(24, 32, 52, 0.30)')
        g.addColorStop(1, 'rgba(24, 32, 52, 0)')
        ctx.save()
        ctx.translate(CX, bottom)
        ctx.scale(1, 0.2)
        ctx.beginPath()
        ctx.arc(0, 0, rx, 0, Math.PI * 2)
        ctx.fillStyle = g
        ctx.fill()
        ctx.restore()
      }

      for (const L of this.layers) {
        if (!L.img) continue
        const def = L.def
        const par = def.parallax ?? 0.5
        const sway = def.sway ?? 0
        const tilt = def.tilt ?? 0

        const dx =
          rig.headX.value * par * 0.85 +
          (rig.tailX ? rig.tailX.value : rig.hairX.value) * sway
        const dy = rig.headY.value * par * 0.5

        ctx.save()
        // 呼吸 + 漂浮（以脚底中点为支点）
        ctx.translate(CX, bottom - rig.floatY)
        ctx.scale(1 - rig.breath * 0.007, 1 + rig.breath * 0.013)
        ctx.translate(-CX, -(bottom - rig.floatY))

        if (def.pivot) {
          ctx.translate(def.pivot[0] * this.scale + bx, def.pivot[1] * this.scale + this.baseY)
          ctx.rotate((rig.lockL.value * tilt + rig.tilt.value * 0.02 * tilt) * 0.0015)
          ctx.translate(-(def.pivot[0] * this.scale + bx), -(def.pivot[1] * this.scale + this.baseY))
        }

        ctx.drawImage(L.img, bx + dx, this.baseY + dy, this.baseW, this.baseH)
        ctx.restore()
      }
    }

    hit() {
      return [
        { x: CX, y: this.baseY + this.baseH * 0.2, rx: this.baseW * 0.34, ry: this.baseH * 0.18 },
        { x: CX, y: this.baseY + this.baseH * 0.62, rx: this.baseW * 0.42, ry: this.baseH * 0.34 },
      ]
    }

    headPoint() {
      return { x: CX, y: this.baseY + this.baseH * 0.2 }
    }
  }

  window.Characters = { PlaceholderCharacter, ImageCharacter, LayeredCharacter, setCanvasHeight }
})()
