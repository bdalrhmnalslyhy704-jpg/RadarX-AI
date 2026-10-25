# RadarX monthly historical replay lab

- Rolling monthly source cases: 12
- Complete detector replays: 12
- Failed or skipped cases: 0
- Replayed detector profile: STRONG_MOVE_RADAR only
- Confirmed positive ex-post anchors: 12
- Positive anchors with at least one accepted signal before anchor: 7
- Accepted decisions: 93
- Successful alerts on fully matured 5%/15% target labels: 72
- False alerts on fully observed horizons: 21
- Missed-move decisions: 14234
- Unique missed positive event anchors: 5
- Median lead time before confirmed event anchor (minutes): 1315
- Explicit-probability calibration: NOT_ESTIMABLE_NO_EXPLICIT_PROBABILITY
- Walk-forward split: READY (train 7752, validation 2088, test 2484).

The ex-post event anchor is only used for lead-time labels after replay. It is never passed into the evaluator.
A complete report covers only the Strong Move detector; other radars are named as unsupported rather than simulated.
