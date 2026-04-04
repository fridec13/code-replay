# Code Replay

코드가 실행되는 순간을 **녹화하고 리플레이**하는 VSCode 확장입니다.

- 실행 중인 함수가 에디터에서 **노란색**으로 강조됩니다.
- 현재 라인의 로컬 변수 값이 인라인으로 표시됩니다.
- 실행이 다른 파일로 넘어가면 그 파일이 자동으로 열립니다.
- 우측 타임라인 패널에서 **배속(0.01x ~ 10x, 스텝/초 기준)** 을 조절하며 실행 흐름을 다시 볼 수 있습니다.
- 함수 호출이 **순번(#1, #2 …)** 과 함께 스피드런 구간(splits)처럼 나눠져 원하는 함수로 바로 점프할 수 있습니다.
- **변수 Diff 테이블**: 스텝마다 이전값 → 현재값 변화를 색상으로 한눈에 확인합니다.
- **콘솔 출력 섹션**: `print()` / `console.log()` 결과를 현재 스텝 기준 앞뒤 컨텍스트로 표시합니다.
- **User / Full 모드**: 유저 코드부터 시작하거나 Python 초기화 포함 전체를 볼 수 있습니다.
- **Python / JavaScript / C++** 세 언어를 지원합니다.

> 영감: 게임 "농부는 대체되었다"의 코드 시각화 + 스타크래프트 리플레이 배속 컨트롤

---

## 동작 방식

```
[ Python / JS / C++ 파일 ]
        │
        ▼ python_tracer.py / js_tracer.js / cpp_tracer.py(GDB) 로 실행
[ JSON 이벤트 스트림 (stdout) ]
        │
        ▼ recorder.ts (child_process)
[ EventStore — TraceEvent[] + FunctionSegment[] + OutputLog[] ]
        │
   ┌────┴────┐
   ▼         ▼
ReplayController    TimelinePanel (WebView)
   │                    • 수평 타임라인 캔버스 (함수 순번 표시)
   ▼                    • 함수 splits 목록
EditorDecorator         • Play/Pause/배속/스크러버
   • 함수명 flash        • 변수 Diff 테이블
   • 라인 하이라이트     • 콘솔 출력 섹션 (접기/펼치기)
   • 인라인 변수 표시
   • 파일 자동 전환
```

**C++ 추적 흐름:**
```
[ .cpp 파일 ]
     │
     ▼ g++ -g -O0 → 임시 바이너리
     ▼ gdb --batch -x cpp_tracer.py --args binary
[ JSON 이벤트 스트림 (GDB Python API) ]
     │
     ▼ recorder.ts
[ 동일한 EventStore / TimelinePanel ]
```

**Live Mode (DAP)** 를 켜면 별도 기록 없이 VSCode 디버거 세션에 붙어 step마다 같은 시각화를 실시간으로 보여줍니다. C++ 디버거(`cppvsdbg`, `CodeLLDB`)도 지원됩니다.

---

## 요구사항

| 항목 | 버전 | 용도 |
|------|------|------|
| VSCode | 1.85 이상 | |
| Node.js | 18 이상 | 확장 빌드 + JS 추적 |
| Python | 3.8 이상 | Python 추적 시 |
| g++ | (MinGW/MSYS2 등) | C++ 추적 시 컴파일 |
| GDB | (MinGW/MSYS2 등) | C++ 추적 시 실행 |

---

## 설치 및 빌드

```bash
# 1. 의존성 설치
npm install

# 2. 확장 빌드
npm run build

# 개발 중 파일 변경 감지 (선택)
npm run watch
```

빌드 결과물은 `dist/extension.js` 에 생성됩니다.

---

## 테스트 (Extension Development Host)

1. 이 폴더를 VSCode에서 열기
2. **F5** 키를 누르면 새 VSCode 창(Extension Development Host)이 열립니다.
   - 빌드가 자동으로 먼저 실행됩니다 (`preLaunchTask: npm: build`).
3. 새 창에서 Python / JS / C++ 파일을 열어 기능을 확인합니다.

> 소스 맵이 포함되어 있으므로, 원본 `.ts` 파일에 중단점을 걸어 디버깅할 수 있습니다.

---

## 사용법

### Record + Replay 모드 (Python)

1. `.py` 파일을 열면 편집기 상단 제목 표시줄에 ▶ 버튼이 나타납니다.
2. 버튼 클릭 또는 `Ctrl+Shift+R` → 기록 시작.
3. 스크립트 실행이 끝나면 알림이 뜹니다.
4. 좌측 Activity Bar → **Code Replay** 아이콘 → **Play** 버튼.

### Record + Replay 모드 (JavaScript)

1. `.js` / `.ts` 파일을 열면 제목 표시줄에 ▶ 버튼이 나타납니다.
2. 버튼 클릭 또는 명령 팔레트(`Ctrl+Shift+P`) → `Code Replay: Record JS/TS File`.

### Record + Replay 모드 (C++)

1. `.cpp` / `.c` / `.cc` / `.cxx` 파일을 열면 제목 표시줄에 ▶ 버튼이 나타납니다.
2. 버튼 클릭 또는 명령 팔레트 → `Code Replay: Record C/C++ File`.
3. 확장이 같은 폴더의 `.cpp` / `.c` / `.cc` / `.cxx` 파일을 **모두** `g++ -g -O0`으로 컴파일 후 GDB로 추적합니다.
4. 완료 알림 이후 타임라인 패널에서 재생합니다.

> **C++ 사전 요건**: `g++`와 `gdb`가 PATH에 있어야 합니다.  
> Windows에서는 [MSYS2](https://www.msys2.org/)를 설치하고 `C:\msys64\mingw64\bin`을 PATH에 추가하거나,  
> 설정에서 `codeReplay.gppPath` / `codeReplay.gdbPath`에 절대경로를 지정합니다.

### Live Mode (DAP)

VSCode 디버거와 연결해 step마다 실시간으로 시각화합니다. 별도 기록 파일은 생성되지 않습니다.

1. 명령 팔레트 → `Code Replay: Attach Live Mode (DAP)` (토글).
2. 디버그 세션을 시작하거나 이미 멈춰 있으면 step을 진행합니다.
3. 멈출 때마다 현재 스택 프레임과 변수가 에디터에 표시됩니다.
4. 다시 실행하면 Live Mode가 꺼집니다.

### 타임라인 패널 조작법

| 동작 | 방법 |
|------|------|
| 재생 / 일시정지 | **Play** 버튼 또는 `Ctrl+Shift+Space` |
| 정지 (처음으로) | **Stop** 버튼 |
| 배속 변경 | 패널 내 속도 버튼 (`0.01x` ~ `10x`) |
| 위치 이동 | 스크러버(슬라이더) 드래그 |
| 함수로 점프 | 좌측 Functions 목록에서 항목 클릭 (순번 #N 표시) |
| 타임라인 클릭 | 해당 시점으로 즉시 이동 |
| 시작점 전환 | **[User]** (내 코드부터) / **[Full]** (Python 내부 포함 전체) 버튼 |
| 콘솔 출력 보기 | 타임라인 아래 **Console** 헤더 클릭으로 펼치기/접기 |

### 패널 위치 이동

기본적으로 좌측 Activity Bar에 Code Replay 아이콘이 생성됩니다.  
우측으로 옮기려면: Activity Bar 아이콘 우클릭 → **Move to Secondary Side Bar**.

### 배속 기준

배속은 **실제 실행 속도와 무관**하게 스텝당 시간으로 결정됩니다.

| 배속 | 속도 |
|------|------|
| `0.01x` | 1 스텝 / 100초 (매우 느림) |
| `0.1x`  | 1 스텝 / 10초 |
| `0.5x`  | 1 스텝 / 2초 |
| `1x`    | 1 스텝 / 1초 (기본) |
| `2x`    | 2 스텝 / 1초 |
| `5x`    | 5 스텝 / 1초 |
| `10x`   | 10 스텝 / 1초 |

### 변수 Diff 테이블

타임라인 위쪽에 현재 스텝의 변수 변화가 표시됩니다.

| 색상 | 의미 |
|------|------|
| 초록 | 숫자 값 증가 |
| 빨강 | 숫자 값 감소 |
| 노란 | 값 변경 (비숫자) |
| 파란 | 새로 등장한 변수 |
| 회색 취소선 | 사라진 변수 |

### 콘솔 출력 섹션

타임라인 아래에 **Console** 섹션이 있습니다 (기본: 접힘).

- 헤더 클릭으로 펼치면 현재 스텝 기준 **앞 5줄 / 뒤 3줄** 컨텍스트가 표시됩니다.
- 현재 스텝에서 출력된 줄: 골드 왼쪽 보더 + 배경 강조
- 아직 실행 안 된 줄: 흐리게 표시
- JavaScript의 `warn` / `error` 레벨은 색상 뱃지로 구분

---

## 명령어

| 명령어 ID | 설명 |
|-----------|------|
| `codeReplay.recordPython` | 현재 Python 파일 기록 시작 |
| `codeReplay.recordJS` | 현재 JS/TS 파일 기록 시작 |
| `codeReplay.recordCpp` | 현재 C/C++ 파일 기록 시작 (g++ 컴파일 + GDB 추적) |
| `codeReplay.liveMode` | Live Mode(DAP) 토글 |
| `codeReplay.openTimeline` | 타임라인 패널 열기 |
| `codeReplay.playPause` | 재생 / 일시정지 |
| `codeReplay.stop` | 정지 |
| `codeReplay.setSpeed` | 배속 선택 (QuickPick) |

---

## 키바인딩

| 단축키 | 동작 | 조건 |
|--------|------|------|
| `Ctrl+Shift+R` (`Cmd+Shift+R`) | Python 파일 기록 시작 | Python 파일 활성 시 |
| `Ctrl+Shift+Space` (`Cmd+Shift+Space`) | 재생 / 일시정지 | 에디터 또는 WebView 포커스 시 |

---

## 설정

`설정(Settings)` → `Code Replay` 또는 `settings.json`에서 직접 변경:

```jsonc
{
  // Python 실행 경로 (가상환경 사용 시 절대경로 권장)
  "codeReplay.pythonPath": "python",

  // Node.js 실행 경로
  "codeReplay.nodePath": "node",

  // g++ 컴파일러 경로 (C++ 추적 시)
  "codeReplay.gppPath": "g++",

  // GDB 실행파일 경로 (C++ 추적 시)
  "codeReplay.gdbPath": "gdb",

  // 기록할 최대 이벤트 수 (초과 시 기록 중단)
  "codeReplay.maxEventsPerTrace": 100000
}
```

Windows MinGW/MSYS2 예시:

```jsonc
{
  "codeReplay.gppPath": "C:\\msys64\\mingw64\\bin\\g++.exe",
  "codeReplay.gdbPath": "C:\\msys64\\mingw64\\bin\\gdb.exe"
}
```

가상환경 Python 예시:

```jsonc
{
  "codeReplay.pythonPath": "C:\\Users\\me\\proj\\.venv\\Scripts\\python.exe"
}
```

---

## 알려진 제한사항

- **Python**: `sys.settrace`는 C 확장 모듈 내부(`numpy`, `pandas` 등)는 추적하지 않습니다. 순수 Python 코드만 추적됩니다.
- **JavaScript**: `--require` 방식으로 주입하므로 ES 모듈(`import`/`export`)을 사용하는 파일은 CommonJS로 변환되어 있어야 합니다. `.mjs` 파일은 지원이 제한적입니다.
- **C++ — 멀티 파일**: 같은 폴더 안의 `.cpp` / `.c` / `.cc` / `.cxx` 파일을 모두 한번에 컴파일합니다. CMake / Makefile 등 별도 빌드 시스템을 사용하는 프로젝트는 직접 바이너리를 빌드한 뒤 GDB + `cpp_tracer.py`로 수동 실행해야 합니다.
- **C++ — 속도**: GDB `step` 기반이라 Python보다 추적이 느릴 수 있습니다. `codeReplay.maxEventsPerTrace`를 낮춰 루프가 많은 코드의 무한 추적을 방지하세요.
- **대규모 코드**: 이벤트가 `maxEventsPerTrace`를 초과하면 기록이 중단됩니다.
- **Live Mode**: DAP `stopped` 이벤트에만 반응합니다. 브레이크포인트 없이 자유 실행 중인 경우는 캡처되지 않습니다.

---

## 프로젝트 구조

```
coderecorder/
├── src/
│   ├── extension.ts        # 진입점, 명령어 등록
│   ├── types.ts            # 공유 타입 (TraceEvent, FunctionSegment, OutputLog 등)
│   ├── recorder.ts         # 자식 프로세스로 tracer 실행 (컴파일 포함)
│   ├── liveDebugBridge.ts  # DAP 이벤트 수신 (Live Mode)
│   ├── eventStore.ts       # 이벤트 저장 및 세그먼트 인덱싱
│   ├── replayController.ts # 재생 엔진 (배속, seek, play/pause)
│   ├── editorDecorator.ts  # 에디터 강조 및 인라인 변수 표시
│   └── timelinePanel.ts    # WebView 타임라인 패널
├── tracers/
│   ├── python_tracer.py    # sys.settrace 기반 Python 추적기
│   ├── js_tracer.js        # Module._compile 훅 기반 JS 추적기
│   └── cpp_tracer.py       # GDB Python API 기반 C++ 추적기
├── media/
│   └── icon.svg            # Activity Bar 아이콘
├── dist/                   # 빌드 결과물
├── esbuild.js              # 번들러 설정
├── package.json
└── tsconfig.json
```
