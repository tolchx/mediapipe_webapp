import type { SynthTelemetry } from '../types/hand';

export class AudioVisualizer {
  private timeData = new Uint8Array(2048);
  private freqData = new Uint8Array(1024);

  render(
    canvas: HTMLCanvasElement,
    analyser: AnalyserNode | null,
    sampleRate: number,
    synth: SynthTelemetry
  ): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Fondo sutil técnico
    ctx.fillStyle = '#090d14';
    ctx.fillRect(0, 0, w, h);

    const splitX = Math.floor(w * 0.62);
    const pad = 10;

    this.drawSpectrum(ctx, 0, 0, splitX, h, analyser, sampleRate, synth);
    this.drawDivider(ctx, splitX, h);
    this.drawOscilloscope(ctx, splitX, 0, w - splitX, h, analyser, synth, pad);

    ctx.restore();
  }

  private freqToLogX(freq: number, x0: number, width: number): number {
    const minF = 40;
    const maxF = 10000;
    const clamped = Math.max(minF, Math.min(maxF, freq));
    const t = Math.log10(clamped / minF) / Math.log10(maxF / minF);
    return x0 + t * width;
  }

  private drawDivider(ctx: CanvasRenderingContext2D, x: number, h: number): void {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 8);
    ctx.lineTo(x + 0.5, h - 8);
    ctx.stroke();
  }

  private drawSpectrum(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    analyser: AnalyserNode | null,
    sampleRate: number,
    synth: SynthTelemetry
  ): void {
    const padX = 12;
    const innerX = x + padX;
    const innerW = w - padX * 2;
    const topY = y + 20;
    const bottomY = y + h - 18;
    const innerH = bottomY - topY;

    // Etiqueta de sección
    ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('ESPECTRO FFT · FRECUENCIAS (Hz)', innerX, 13);

    // Grid logarítmico de frecuencias
    const gridFreqs = [60, 100, 220, 440, 1000, 2500, 5000, 8000];
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (const gf of gridFreqs) {
      const gx = this.freqToLogX(gf, innerX, innerW);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, topY);
      ctx.lineTo(gx, bottomY);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      const label = gf >= 1000 ? `${gf / 1000}k` : String(gf);
      ctx.fillText(label, gx - 8, h - 5);
    }

    // Curva FFT real si el AudioContext está activo
    if (analyser && synth.active) {
      if (this.freqData.length !== analyser.frequencyBinCount) {
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this.freqData);

      const nyquist = sampleRate / 2;
      const binCount = this.freqData.length;

      const grad = ctx.createLinearGradient(0, topY, 0, bottomY);
      grad.addColorStop(0, 'rgba(167, 139, 250, 0.85)');
      grad.addColorStop(0.55, 'rgba(34, 211, 238, 0.45)');
      grad.addColorStop(1, 'rgba(34, 211, 238, 0.05)');

      ctx.beginPath();
      ctx.moveTo(innerX, bottomY);
      const steps = Math.max(40, Math.floor(innerW / 2));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const f = 40 * Math.pow(10000 / 40, t);
        const bin = Math.min(binCount - 1, Math.max(1, Math.round((f / nyquist) * binCount)));
        const val = this.freqData[bin] / 255;
        const px = innerX + t * innerW;
        const py = bottomY - val * innerH;
        ctx.lineTo(px, py);
      }
      ctx.lineTo(innerX + innerW, bottomY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Trazo superior brillante
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const f = 40 * Math.pow(10000 / 40, t);
        const bin = Math.min(binCount - 1, Math.max(1, Math.round((f / nyquist) * binCount)));
        const val = this.freqData[bin] / 255;
        const px = innerX + t * innerW;
        const py = bottomY - val * innerH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#a78bfa';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else {
      // Línea base cuando audio está apagado
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath();
      ctx.moveTo(innerX, bottomY);
      ctx.lineTo(innerX + innerW, bottomY);
      ctx.stroke();
    }

    // Marcador de frecuencia fundamental objetivo
    const fundX = this.freqToLogX(synth.quantizedFreqHz, innerX, innerW);
    ctx.strokeStyle = synth.handDetected ? '#34d399' : 'rgba(52, 211, 153, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fundX, topY);
    ctx.lineTo(fundX, bottomY);
    ctx.stroke();

    // Marcador de Cutoff del filtro
    const cutX = this.freqToLogX(synth.cutoffHz, innerX, innerW);
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.75)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cutX, topY);
    ctx.lineTo(cutX, bottomY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#34d399';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`f0 ${synth.quantizedFreqHz.toFixed(0)}Hz`, Math.min(fundX + 4, innerX + innerW - 72), topY + 10);

    ctx.fillStyle = '#fb923c';
    ctx.fillText(`LP ${Math.round(synth.cutoffHz)}Hz`, Math.min(cutX + 4, innerX + innerW - 65), topY + 22);
  }

  private drawOscilloscope(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    analyser: AnalyserNode | null,
    synth: SynthTelemetry,
    pad: number
  ): void {
    const innerX = x + pad;
    const innerW = w - pad * 2;
    const topY = y + 20;
    const bottomY = y + h - 12;
    const midY = (topY + bottomY) / 2;
    const amp = (bottomY - topY) * 0.44;

    ctx.fillStyle = 'rgba(148, 163, 184, 0.72)';
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('OSCILOSCOPIO', innerX, 13);

    // Línea cero
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(innerX, midY);
    ctx.lineTo(innerX + innerW, midY);
    ctx.stroke();

    ctx.beginPath();
    if (analyser && synth.active) {
      if (this.timeData.length !== analyser.fftSize) {
        this.timeData = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(this.timeData);

      // Zero-crossing trigger simple para estabilizar forma de onda visual
      let trigger = 0;
      for (let i = 1; i < this.timeData.length / 2; i++) {
        if (this.timeData[i - 1] < 128 && this.timeData[i] >= 128) {
          trigger = i;
          break;
        }
      }

      const samplesToDraw = Math.min(512, this.timeData.length - trigger);
      for (let i = 0; i < samplesToDraw; i++) {
        const v = (this.timeData[trigger + i] - 128) / 128;
        const px = innerX + (i / (samplesToDraw - 1)) * innerW;
        const py = midY - v * amp * 1.15;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    } else {
      // Previsualización sintética suave de frecuencia aunque esté silenciado
      const cycles = Math.max(1.5, Math.min(10, synth.quantizedFreqHz / 110));
      const previewAmp = synth.handDetected ? amp * 0.55 : amp * 0.14;
      const steps = Math.max(40, Math.floor(innerW / 2));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = innerX + t * innerW;
        const py = midY - Math.sin(t * Math.PI * 2 * cycles) * previewAmp;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.35)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }
}
