/**
 * Remotion 進入點。分鏡秒數來自 kbot_traffic_30s.beats.json(錄影當下實測),
 * 這裡直接寫成常數,改字卡時機就改 CAPTIONS 的 fromFrame / durationInFrames。
 *
 * 注意:**成品畫面上的文字一律不出現機型代號**(企劃書要求),一律寫
 * 「機器人 / 指揮機器人」。檔名與元件名只是程式碼、不會進畫面,維持原樣。
 */
import React from 'react';
import { Composition } from 'remotion';
import { FPS, KbotTrafficDemo, KbotPoster } from './KbotTrafficDemo';

// 來自 kbot_traffic_30s.beats.json 的 durationFrames。重錄後要一起改。
const DURATION_IN_FRAMES = 1022;

// fromFrame 對齊 beats.json 的 atFrame:
//   a_overview 0 / b_walk 187 / b_post 619 / c_retreat 868 / c_safe 931
const CAPTIONS = [
  {
    // A 段:鳥瞰(0–187)
    fromFrame: 12,
    durationInFrames: 150,
    title: '公館路口・數位孿生',
    body: '車道、停止線、行人穿越道全部照實景標線量測建模;中央是公車專用道與兩座月台。',
  },
  {
    // B 段:跟拍他從人行道走進路口(187 → 619)
    fromFrame: 250,
    durationInFrames: 170,
    title: '他自己走進路口',
    body: '行人相位一開始,指揮機器人從人行道走到行穿線中央——步態是實際物理模擬烘焙的,不是滑行。',
  },
  {
    // B 段後半:站定指揮(619 → 868)
    fromFrame: 640,
    durationInFrames: 180,
    title: '手勢就是號誌',
    body: '舉手全停,行人開始穿越。任何放行都要先過安全閘門:路口淨空、行穿線淨空、下游不堵。',
  },
  {
    // C 段:退場(868 → 1022)
    fromFrame: 875,
    durationInFrames: 140,
    title: '指揮者自己也被安全閘門管',
    body: '號誌要換之前他先退到最近的安全點——中央公車站月台。人還在車道上,系統就不准放行任何車流。',
  },
];

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="KbotTrafficDemo"
        component={KbotTrafficDemo}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{
          src: 'kbot_traffic_30s.mp4',
          captions: CAPTIONS,
          title: '機器人在路口指揮交通',
          subtitle: '封閉場域數位孿生 ・ 台灣交通規則模擬',
          disclaimer: '封閉場域展示,非公共道路實際交通指揮系統;本機器人不具法定指揮權。',
        }}
      />
      <Composition
        id="KbotPoster"
        component={KbotPoster}
        durationInFrames={1}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ src: 'kbot_traffic_30s_poster.jpg' }}
      />
    </>
  );
};
