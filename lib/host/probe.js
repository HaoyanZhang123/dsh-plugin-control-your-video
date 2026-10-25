// Media probing: real metadata, never model self-report.
import { execFileSync } from 'node:child_process';
export function probeMedia(ffprobePath, file) {
    if (!ffprobePath)
        return { duration_seconds: 0, width: 0, height: 0, fps: 0, has_audio: false, verified: false, error: 'ffprobe unavailable' };
    try {
        const raw = execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
        const parsed = JSON.parse(raw);
        const streams = parsed.streams ?? [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        const rate = v && v.r_frame_rate ? v.r_frame_rate.split('/').map(Number) : [0, 1];
        const fps = rate[1] ? Math.round((rate[0] / rate[1]) * 1000) / 1000 : 0;
        return {
            duration_seconds: Number(parsed.format?.duration ?? 0),
            width: v?.width ?? 0,
            height: v?.height ?? 0,
            fps,
            has_audio: Boolean(a),
            verified: true,
        };
    }
    catch (e) {
        return { duration_seconds: 0, width: 0, height: 0, fps: 0, has_audio: false, verified: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) };
    }
}
