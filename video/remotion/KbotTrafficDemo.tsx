/**
 * 公館 KBot 交通指揮 — Remotion 展示合成
 *
 * 底片是 headless Chrome 錄下來的 viewer 實機畫面(1920x1080 / 30fps),
 * 這支合成只負責「加字卡」:標題、三段分鏡的說明條、片尾聲明。
 * 每個分鏡的秒數不是我猜的,是錄影當下量到的,存在 kbot_traffic_30s.beats.json。
 *
 * 用法:把這個檔案跟 Root.tsx 放進你的 Remotion 專案 src/,
 * 影片放 public/kbot_traffic_30s.mp4,然後 npx remotion studio。
 */
import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const FPS = 30;

/** 錄影當下量到的分鏡時間軸(kbot_traffic_30s.beats.json)。改這裡就會改字卡時機。 */
export type Beat = {
  id: string;
  label: string;
  atSeconds: number;
  atFrame: number;
};

export type KbotTrafficDemoProps = {
  /** public/ 底下的影片檔名 */
  src: string;
  /** 每段字卡:從第幾格開始、持續幾格、標題、說明 */
  captions: Array<{
    fromFrame: number;
    durationInFrames: number;
    title: string;
    body: string;
  }>;
  title: string;
  subtitle: string;
  disclaimer: string;
};

const FONT_STACK =
  '"PingFang TC", "Noto Sans TC", "Heiti TC", system-ui, -apple-system, sans-serif';

const INK = '#eaf6f2';
const ACCENT = '#38e6b0';
const SHADOW = '0 2px 18px rgba(0,0,0,0.75)';

/** 淡入淡出:進場 12 格、出場 12 格。 */
const useFade = (fromFrame: number, durationInFrames: number) => {
  const frame = useCurrentFrame();
  const local = frame - fromFrame;
  if (local < 0 || local > durationInFrames) return 0;
  return interpolate(
    local,
    [0, 12, durationInFrames - 12, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );
};

const TitleCard: React.FC<{ title: string; subtitle: string }> = ({
  title,
  subtitle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = useFade(0, 4 * FPS);
  const rise = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 30 });
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        padding: '0 96px 108px',
        fontFamily: FONT_STACK,
        opacity,
      }}
    >
      <div style={{ transform: `translateY(${(1 - rise) * 24}px)` }}>
        <div
          style={{
            color: ACCENT,
            fontSize: 24,
            letterSpacing: 6,
            fontWeight: 700,
            textShadow: SHADOW,
          }}
        >
          GONGGUAN DIGITAL TWIN
        </div>
        <div
          style={{
            color: INK,
            fontSize: 76,
            fontWeight: 800,
            marginTop: 10,
            textShadow: SHADOW,
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: 'rgba(234,246,242,0.82)',
            fontSize: 30,
            marginTop: 12,
            textShadow: SHADOW,
          }}
        >
          {subtitle}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Caption: React.FC<{
  fromFrame: number;
  durationInFrames: number;
  title: string;
  body: string;
}> = ({ fromFrame, durationInFrames, title, body }) => {
  const opacity = useFade(fromFrame, durationInFrames);
  if (opacity === 0) return null;
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        padding: '0 96px 96px',
        fontFamily: FONT_STACK,
        opacity,
      }}
    >
      <div
        style={{
          alignSelf: 'flex-start',
          maxWidth: 980,
          background: 'rgba(8,21,27,0.72)',
          backdropFilter: 'blur(10px)',
          borderLeft: `4px solid ${ACCENT}`,
          borderRadius: 8,
          padding: '22px 30px',
        }}
      >
        <div style={{ color: ACCENT, fontSize: 30, fontWeight: 800 }}>{title}</div>
        <div
          style={{
            color: INK,
            fontSize: 27,
            lineHeight: 1.55,
            marginTop: 8,
          }}
        >
          {body}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Disclaimer: React.FC<{ text: string }> = ({ text }) => {
  const { durationInFrames } = useVideoConfig();
  const opacity = useFade(durationInFrames - 4 * FPS, 4 * FPS);
  if (opacity === 0) return null;
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-start',
        alignItems: 'flex-end',
        padding: '40px 60px',
        fontFamily: FONT_STACK,
        opacity,
      }}
    >
      <div
        style={{
          color: 'rgba(234,246,242,0.8)',
          fontSize: 20,
          textShadow: SHADOW,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const KbotTrafficDemo: React.FC<KbotTrafficDemoProps> = ({
  src,
  captions,
  title,
  subtitle,
  disclaimer,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#08151b' }}>
      <OffthreadVideo src={staticFile(src)} />

      {/* 下緣壓暗,字才吃得住 */}
      <AbsoluteFill
        style={{
          background:
            'linear-gradient(to top, rgba(4,10,14,0.85) 0%, rgba(4,10,14,0.35) 26%, rgba(4,10,14,0) 48%)',
        }}
      />

      <TitleCard title={title} subtitle={subtitle} />
      {captions.map((caption) => (
        <Caption key={caption.fromFrame} {...caption} />
      ))}
      <Disclaimer text={disclaimer} />
    </AbsoluteFill>
  );
};

/** 需要靜態海報時用得到(社群預覽圖之類)。 */
export const KbotPoster: React.FC<{ src: string }> = ({ src }) => (
  <AbsoluteFill>
    <Img src={staticFile(src)} />
  </AbsoluteFill>
);
