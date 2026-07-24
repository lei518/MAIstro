const EPSILON = 0.000001;
const DEFAULT_REPEAT_TIMES = 2;
const MAX_PLAYBACK_MEASURES = 10000;

function getDirectChild(parent, tagName) {
  if (!parent) return null;

  return (
    Array.from(parent.children).find(
      (child) =>
        child.localName?.toLowerCase() ===
        tagName.toLowerCase(),
    ) || null
  );
}

function getDirectNumber(
  parent,
  tagName,
  fallback = 0,
) {
  const child = getDirectChild(parent, tagName);
  const value = Number(
    child?.textContent?.trim(),
  );

  return Number.isFinite(value)
    ? value
    : fallback;
}

function getRepeatInfo(measure) {
  let forwardRepeat = false;
  let backwardRepeat = false;
  let repeatTimes = DEFAULT_REPEAT_TIMES;

  const repeatElements =
    measure.querySelectorAll('barline > repeat');

  repeatElements.forEach((repeat) => {
    const direction =
      repeat.getAttribute('direction');

    if (direction === 'forward') {
      forwardRepeat = true;
    }

    if (direction === 'backward') {
      backwardRepeat = true;

      const parsedTimes = Number(
        repeat.getAttribute('times'),
      );

      if (
        Number.isFinite(parsedTimes) &&
        parsedTimes >= 1
      ) {
        repeatTimes = parsedTimes;
      }
    }
  });

  const rightBarStyle =
    measure
      .querySelector(
        'barline[location="right"] > bar-style',
      )
      ?.textContent?.trim() || '';

  return {
    forwardRepeat,
    backwardRepeat,
    repeatTimes,
    rightBarStyle,
  };
}

function inferMissingClosingRepeats(sourceMeasures) {
  let openForwardIndex = null;
  let inferredRepeatCount = 0;

  sourceMeasures.forEach((measure, index) => {
    if (measure.forwardRepeat) {
      /*
       * A new forward repeat while another is still open usually means
       * Audiveris missed the preceding backward-repeat dots. Only infer
       * a close when the preceding measure has a strong closing barline.
       */
      if (openForwardIndex !== null && index > 0) {
        const precedingMeasure = sourceMeasures[index - 1];

        if (
          !precedingMeasure.backwardRepeat &&
          precedingMeasure.rightBarStyle === 'light-heavy'
        ) {
          precedingMeasure.backwardRepeat = true;
          precedingMeasure.repeatTimes =
            DEFAULT_REPEAT_TIMES;
          precedingMeasure.inferredBackwardRepeat = true;
          inferredRepeatCount += 1;
        }
      }

      openForwardIndex = index;
    }

    if (measure.backwardRepeat) {
      openForwardIndex = null;
    }
  });

  /*
   * The uploaded saxophone score has a final repeat close. Some
   * Audiveris exports preserve the final heavy barline but omit the
   * backward-repeat element. Infer it only when an explicit forward
   * repeat remains unmatched.
   */
  if (
    openForwardIndex !== null &&
    sourceMeasures.length > 0
  ) {
    const finalMeasure =
      sourceMeasures[sourceMeasures.length - 1];

    if (
      !finalMeasure.backwardRepeat &&
      finalMeasure.rightBarStyle === 'light-heavy'
    ) {
      finalMeasure.backwardRepeat = true;
      finalMeasure.repeatTimes =
        DEFAULT_REPEAT_TIMES;
      finalMeasure.inferredBackwardRepeat = true;
      inferredRepeatCount += 1;
    }
  }

  return inferredRepeatCount;
}

function buildPlaybackMeasures(sourceMeasures) {
  if (sourceMeasures.length === 0) {
    return [];
  }

  const playbackMeasures = [];
  const repeatPassBySection = new Map();

  let sourceIndex = 0;
  let repeatStartIndex = 0;
  let playbackBeat = 0;
  let guard = 0;

  while (
    sourceIndex < sourceMeasures.length &&
    guard < MAX_PLAYBACK_MEASURES
  ) {
    const sourceMeasure =
      sourceMeasures[sourceIndex];

    if (sourceMeasure.forwardRepeat) {
      repeatStartIndex = sourceIndex;
    }

    const repeatKey =
      `${repeatStartIndex}:${sourceIndex}`;

    const currentRepeatPass =
      repeatPassBySection.get(repeatKey) || 1;

    const occurrence = {
      ...sourceMeasure,
      sourceIndex,
      sourceStartBeat: sourceMeasure.startBeat,
      sourceEndBeat: sourceMeasure.endBeat,
      startBeat: playbackBeat,
      endBeat:
        playbackBeat +
        sourceMeasure.durationBeats,
      playbackIndex: playbackMeasures.length,
      repeatPass: currentRepeatPass,
    };

    playbackMeasures.push(occurrence);

    playbackBeat = occurrence.endBeat;

    if (sourceMeasure.backwardRepeat) {
      const totalPasses = Math.max(
        1,
        sourceMeasure.repeatTimes ||
          DEFAULT_REPEAT_TIMES,
      );

      if (currentRepeatPass < totalPasses) {
        repeatPassBySection.set(
          repeatKey,
          currentRepeatPass + 1,
        );

        sourceIndex = repeatStartIndex;
        guard += 1;
        continue;
      }

      repeatPassBySection.delete(repeatKey);
      repeatStartIndex = sourceIndex + 1;
    }

    sourceIndex += 1;
    guard += 1;
  }

  return playbackMeasures;
}

export function buildScoreTimeline(musicxml) {
  const fallback = {
    totalBeats: 0,
    sourceTotalBeats: 0,
    totalMeasures: 0,
    playbackMeasureCount: 0,
    beatsPerMeasure: 4,
    beatType: 4,
    timeSignature: '4/4',
    sourceMeasures: [],
    measures: [],
    recognizedRepeatCount: 0,
    inferredRepeatCount: 0,
    totalRepeatCount: 0,
    hasRecognizedRepeats: false,
    doubleBarMeasures: [],
  };

  if (!musicxml) return fallback;

  try {
    const parser = new DOMParser();

    const xml = parser.parseFromString(
      musicxml,
      'application/xml',
    );

    if (xml.querySelector('parsererror')) {
      return fallback;
    }

    const part = xml.querySelector('part');

    if (!part) {
      return fallback;
    }

    const measureElements =
      Array.from(part.children).filter(
        (child) =>
          child.localName?.toLowerCase() ===
          'measure',
      );

    const firstTime =
      xml.querySelector('time');

    const firstBeats =
      Number(
        firstTime
          ?.querySelector('beats')
          ?.textContent?.trim(),
      ) || 4;

    const firstBeatType =
      Number(
        firstTime
          ?.querySelector('beat-type')
          ?.textContent?.trim(),
      ) || 4;

    let divisions = 1;
    let runningSourceBeat = 0;

    const sourceMeasures = [];

    measureElements.forEach(
      (measure, measureIndex) => {
        let localQuarterPosition = 0;
        let maximumQuarterPosition = 0;
        let currentBeats = firstBeats;
        let currentBeatType = firstBeatType;

        Array.from(measure.children).forEach(
          (element) => {
            const name =
              element.localName?.toLowerCase();

            if (name === 'attributes') {
              const nextDivisions =
                getDirectNumber(
                  element,
                  'divisions',
                  divisions,
                );

              if (nextDivisions > 0) {
                divisions = nextDivisions;
              }

              const time =
                getDirectChild(
                  element,
                  'time',
                );

              if (time) {
                const nextBeats =
                  getDirectNumber(
                    time,
                    'beats',
                    currentBeats,
                  );

                const nextBeatType =
                  getDirectNumber(
                    time,
                    'beat-type',
                    currentBeatType,
                  );

                if (nextBeats > 0) {
                  currentBeats =
                    nextBeats;
                }

                if (nextBeatType > 0) {
                  currentBeatType =
                    nextBeatType;
                }
              }

              return;
            }

            if (name === 'note') {
              const duration =
                getDirectNumber(
                  element,
                  'duration',
                  0,
                );

              const isChord = Boolean(
                getDirectChild(
                  element,
                  'chord',
                ),
              );

              if (
                !isChord &&
                duration > 0 &&
                divisions > 0
              ) {
                localQuarterPosition +=
                  duration / divisions;

                maximumQuarterPosition =
                  Math.max(
                    maximumQuarterPosition,
                    localQuarterPosition,
                  );
              }

              return;
            }

            if (name === 'backup') {
              const duration =
                getDirectNumber(
                  element,
                  'duration',
                  0,
                );

              if (
                duration > 0 &&
                divisions > 0
              ) {
                localQuarterPosition =
                  Math.max(
                    0,
                    localQuarterPosition -
                      duration / divisions,
                  );
              }

              return;
            }

            if (name === 'forward') {
              const duration =
                getDirectNumber(
                  element,
                  'duration',
                  0,
                );

              if (
                duration > 0 &&
                divisions > 0
              ) {
                localQuarterPosition +=
                  duration / divisions;

                maximumQuarterPosition =
                  Math.max(
                    maximumQuarterPosition,
                    localQuarterPosition,
                  );
              }
            }
          },
        );

        const fallbackQuarterLength =
          currentBeats *
          (4 / currentBeatType);

        const quarterLength =
          maximumQuarterPosition > EPSILON
            ? maximumQuarterPosition
            : fallbackQuarterLength;

        const measureBeatLength =
          quarterLength *
          (firstBeatType / 4);

        const repeatInfo =
          getRepeatInfo(measure);

        const startBeat =
          runningSourceBeat;

        const endBeat =
          startBeat + measureBeatLength;

        sourceMeasures.push({
          index: measureIndex,
          number:
            measure.getAttribute('number') ||
            String(measureIndex + 1),
          startBeat,
          endBeat,
          durationBeats:
            measureBeatLength,
          beats: currentBeats,
          beatType: currentBeatType,
          ...repeatInfo,
        });

        runningSourceBeat = endBeat;
      },
    );

    const inferredRepeatCount =
      inferMissingClosingRepeats(sourceMeasures);

    const playbackMeasures =
      buildPlaybackMeasures(sourceMeasures);

    const totalBeats =
      playbackMeasures.length > 0
        ? playbackMeasures[
            playbackMeasures.length - 1
          ].endBeat
        : 0;

    const recognizedRepeatCount =
      sourceMeasures.filter(
        (measure) =>
          measure.backwardRepeat &&
          !measure.inferredBackwardRepeat,
      ).length;

    const totalRepeatCount =
      recognizedRepeatCount +
      inferredRepeatCount;

    const doubleBarMeasures =
      sourceMeasures
        .filter(
          (measure) =>
            measure.rightBarStyle ===
              'light-light' &&
            !measure.backwardRepeat,
        )
        .map((measure) => measure.number);

    return {
      totalBeats,
      sourceTotalBeats:
        runningSourceBeat,
      totalMeasures:
        sourceMeasures.length,
      playbackMeasureCount:
        playbackMeasures.length,
      beatsPerMeasure: firstBeats,
      beatType: firstBeatType,
      timeSignature:
        `${firstBeats}/${firstBeatType}`,
      sourceMeasures,
      measures: playbackMeasures,
      recognizedRepeatCount,
      inferredRepeatCount,
      totalRepeatCount,
      hasRecognizedRepeats:
        totalRepeatCount > 0,
      doubleBarMeasures,
    };
  } catch {
    return fallback;
  }
}

export function getScoreStateAtBeat(
  timeline,
  beatValue,
) {
  const safeBeat =
    Number.isFinite(beatValue)
      ? Math.max(0, beatValue)
      : 0;

  const measures =
    timeline?.measures || [];

  if (measures.length === 0) {
    return {
      measureIndex: 0,
      measureNumber: 0,
      playbackMeasureNumber: 0,
      repeatPass: 1,
      beatInMeasure: 1,
      beatsPerMeasure:
        timeline?.beatsPerMeasure || 4,
      beatType:
        timeline?.beatType || 4,
      localBeat: safeBeat,
    };
  }

  let selected =
    measures[measures.length - 1];

  for (const measure of measures) {
    if (
      safeBeat <
      measure.endBeat - EPSILON
    ) {
      selected = measure;
      break;
    }
  }

  const localBeat = Math.max(
    0,
    safeBeat - selected.startBeat,
  );

  const beatInMeasure = Math.max(
    1,
    Math.min(
      selected.beats ||
        timeline.beatsPerMeasure ||
        4,
      Math.floor(
        localBeat + EPSILON,
      ) + 1,
    ),
  );

  return {
    measureIndex:
      selected.sourceIndex ??
      selected.index,
    measureNumber:
      selected.number ??
      selected.sourceIndex + 1,
    playbackMeasureNumber:
      selected.playbackIndex + 1,
    repeatPass:
      selected.repeatPass || 1,
    beatInMeasure,
    beatsPerMeasure:
      selected.beats ||
      timeline.beatsPerMeasure ||
      4,
    beatType:
      selected.beatType ||
      timeline.beatType ||
      4,
    localBeat,
  };
}
