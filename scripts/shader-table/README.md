# 셰이더 관측 표

실제 캡처에서 가져온 관측 또는 합성 표를 검사해 Hub expert_reprompt가 받을 요청을 만든다. `python shader_table.py check TABLE.json --payload payload.json`로 요청을 저장하고 `python shader_table.py selftest`로 동봉한 합성 사례를 확인한다.

## 표 형식 (`schemaVersion` 1)

```
{ "schemaVersion": 1,
  "frameCapture": { …frame_capture_analyze 출력, 선택… },
  "shaders": [ {
    "id": "…", "capture": {"source": "synthetic | renderdoc"}, "pass": "…", "stage": "vertex | pixel | compute",
    "textures":    [ {"name", "format", "colorSpace": "srgb|linear|data", "sampledAs"} ],
    "coordinates": [ {"name", "space": "object|world|view|clip|ndc|screen|uv|tangent", "consumedAs"} ],
    "units":       [ {"name", "unit": "m|cm|degree|radian|0-1|…", "consumedAs"} ],
    "observations": {"nanPixels", "infPixels", "drawCalls", "drawCallBudget", "resourceBytesByFrame": [..]} } ] }
```

## 검사와 "관측 가능할 때만" 규칙

| 검사 | 보고 조건 | 값이 없을 때 |
|---|---|---|
| space-mismatch | 좌표의 `space`와 `consumedAs`가 둘 다 있고 다름 | 한쪽이 없으면 `missingInputs`, 표가 없으면 `notObserved` |
| unit-mismatch | `unit`과 `consumedAs`가 둘 다 있고 다름 | 같음 |
| colorspace-mismatch | 텍스처의 `colorSpace`와 `sampledAs`가 둘 다 있고 다름 | 보고 없음 |
| nan | `nanPixels` 또는 `infPixels`가 숫자이고 0보다 큼 | 숫자가 아니면 `notObserved: nan` |
| drawcalls | 측정한 그리기 수(표, 없으면 붙인 캡처의 같은 이름 패스)가 표의 `drawCallBudget`보다 큼 | 측정값이나 예산이 없으면 `notObserved` |
| resource-growth | 표본 3개 이상이 매번 증가하고 총 증가가 1 MiB 이상 | 표본 부족이면 `notObserved`. 증가는 누수의 증거가 아니라 증가의 증거로만 적는다 |

검사는 표에 적힌 값의 불일치만 찾는다. 셰이더 소스를 읽거나 실행하지 않으므로, 표를 틀리게 적으면 결과도 틀린다.

