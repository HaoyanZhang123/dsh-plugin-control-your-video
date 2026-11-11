/**
 * GENERATED FILE — do not edit.
 *
 * Produced by 产品实现/acceptance/real-work/scripts/embed-snapshot.mjs from the evidence JSON in
 * 实施交接/证据/C15R-证据/. Every number below is copied from a measured file listed in
 * `sources`; re-run the generator after re-measuring instead of editing this file.
 */

const REALWORK_SNAPSHOT = {
  "kind": "c15r-realwork-snapshot",
  "generatedAt": "2026-11-10T14:20:00.000Z",
  "generator": "产品实现/acceptance/real-work/scripts/embed-snapshot.mjs",
  "sources": [
    {
      "file": "05-完整初版/render-result-v1.json",
      "bytes": 5132,
      "sha256": "36d5ed7957b5b7436672bc4f93658f8d1f00173617548c994014ebf31380d6cf"
    },
    {
      "file": "05-完整初版/measurement-v1.json",
      "bytes": 7746,
      "sha256": "aa849ad6cf8a3aab4b959933e26eab8f8343c5eba6349997f56c45fd4f459cf4"
    },
    {
      "file": "06-局部修改/measurement-rule4-late2-v1.json",
      "bytes": 7765,
      "sha256": "d1ba969f8a141d1aeed1d037204c64d430549bcaf87f019187f4d6a80bf4b214"
    },
    {
      "file": "06-局部修改/comparison-rule4-late2.json",
      "bytes": 19894,
      "sha256": "872430a39e4ab1b4d586c0a36bbad0e87b2188eb4557b42e693e7c3ab9a5a74a"
    },
    {
      "file": "06-局部修改/still-comparison.json",
      "bytes": 8680,
      "sha256": "ecc8da2e426ac2a9cc3e026926bf6f1d8cf191e0356c0f7fe7802b7d35dbf399"
    },
    {
      "file": "06-局部修改/click-onset-control.json",
      "bytes": 3838,
      "sha256": "d586af1227ef011820ae1d8abd1a645f891e8e68faf4d7b945db1aaf4395d425"
    },
    {
      "file": "产品实现/acceptance/real-work/project/audio/c15r-score.events.json",
      "bytes": 5130,
      "sha256": "31320d6236e0b18074327df5f11b2a04948447d27227f653e6cfa4c192b39947"
    },
    {
      "file": "08-交付/交付清单.json",
      "bytes": 4052,
      "sha256": "cc775118ae816b922ca206f0685d62d836cb706e799b53f5b8d61bf27d5f805d"
    }
  ],
  "film": {
    "title": "《起／落》",
    "palette": "黑 #000000 ／ 米白 #F2EDE3",
    "font": "Noto Serif SC",
    "fontLicense": "SIL OFL 1.1",
    "runtime": "Remotion 4.0.541",
    "runtimeNote": "FFmpeg 适配器在本片暴露两处限制（场景 alpha 时间基准、多转场偏移），换用已注册的 Remotion，未改 C12",
    "planVersion": "direction-b-1.0.1-rule4-late2",
    "accepted": true
  },
  "spec": {
    "totalFrames": 360,
    "width": 1920,
    "height": 1080,
    "fps": "30/1",
    "videoCodec": "h264",
    "pixelFormat": "yuv420p",
    "videoStreamSeconds": 12,
    "containerSeconds": 12.011,
    "audioCodec": "aac",
    "audioSampleRate": 48000,
    "audioChannels": 2,
    "videoSha256": "5798df8642d7b02511e1ccbb2cda02ae75d6b54af7000eb6452d7ef4a20104eb",
    "videoBytes": 570338
  },
  "toleranceFrames": 1,
  "maxAbsDeltaFrames": 0.149,
  "encodeDelayFrames": 0,
  "rules": [
    {
      "objectId": "obj-s2-rule1",
      "measuredFirstVisibleFrame": 91,
      "clickOnsetFrame": 91.149,
      "deltaFrames": 0.149
    },
    {
      "objectId": "obj-s2-rule2",
      "measuredFirstVisibleFrame": 113,
      "clickOnsetFrame": 113.149,
      "deltaFrames": 0.149
    },
    {
      "objectId": "obj-s2-rule3",
      "measuredFirstVisibleFrame": 136,
      "clickOnsetFrame": 136.149,
      "deltaFrames": 0.149
    },
    {
      "objectId": "obj-s2-rule4",
      "measuredFirstVisibleFrame": 160,
      "clickOnsetFrame": 160.149,
      "deltaFrames": 0.149
    }
  ],
  "repair": {
    "request": "第四条线晚 2 帧；该声点击同步后移 2 帧，保持同帧对齐",
    "planVersionFrom": "direction-b-1.0.0",
    "planVersionTo": "direction-b-1.0.1-rule4-late2",
    "changedFrames": [
      158,
      159,
      160,
      161,
      163,
      164
    ],
    "targetVisibleSharePercent": 6.286,
    "othersVisibleSharePercent": 0.196,
    "audioNote": "源 WAV 只有两段差异（旧点击与新点击各 60ms）；编码后点击落点相对源 WAV 移动 0 帧",
    "accepted": true,
    "acceptanceQuote": "接受",
    "acceptedAt": "2026-11-10T18:49:54+08:00",
    "deliveredFile": "实施交接/证据/C15R-证据/08-交付/C15R-起落-12s-定稿-v1.mp4"
  },
  "observation": {
    "saw": true,
    "viewedFrames": "逐张放大：第 45、81、93、159、216、294 帧；另看 12／16 格接触表与波形图",
    "heard": "未听：宿主没有听辨通道，波形只证明有四声点击与包络，不证明听感",
    "notVerified": [
      "整片连续播放的流畅度",
      "音频听感与响度",
      "其他机器上的渲染一致性"
    ]
  },
  "planNotes": {
    "scenes": [
      {
        "id": "s1",
        "startFrame": 0,
        "durationFrames": 90
      },
      {
        "id": "s2",
        "startFrame": 90,
        "durationFrames": 90
      },
      {
        "id": "s3",
        "startFrame": 180,
        "durationFrames": 90
      },
      {
        "id": "s4",
        "startFrame": 270,
        "durationFrames": 90
      }
    ],
    "repairPlanVersion": "direction-b-1.0.1-rule4-late2"
  }
}
