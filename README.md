# roosycozy (Tauri v2 + Vite)

웹(`npm run dev`)과 데스크톱(`npm run tauri dev`) 모두에서 **동일한 코드**로 동작하는 완성 예제입니다.

- Web(dev): `localStorage`
- Desktop(Tauri v2): `AppDataDir/roosycozy_state_v1.json` 파일에 저장 (tauri plugin-fs)
- 기록 삭제 정책: 해당 기록이 포함되는 케이스가 존재하면 삭제 불가
- 케이스 삭제: 언제든 가능
- 디버그 패널: 오른쪽 상단 **🐞** 버튼 또는 `Ctrl/Cmd + \` 로 토글 (Tauri에서 콘솔이 안 보일 때 유용)

## 실행

```bash
npm install

# 브라우저에서만 실행
npm run dev

# 데스크톱(Tauri) 실행
npm run tauri dev
```

## 데스크톱에서 DevTools(Inspect) 열기

Tauri dev 실행 중에는 보통 **우클릭 → Inspect** 로 웹 인스펙터를 열 수 있습니다. (OS/환경에 따라 단축키가 다를 수 있어요.)

만약 버튼이 먹통처럼 보이면, 이 프로젝트는 화면 안에 **🐞 디버그 패널**을 제공해서 저장/에러 로그를 바로 볼 수 있게 해뒀습니다.

## 저장 파일 위치

Tauri(AppDataDir)에 아래 파일로 저장됩니다.

- `roosycozy_state_v1.json`

(정확한 경로는 OS별 AppDataDir 규칙에 따릅니다.)
