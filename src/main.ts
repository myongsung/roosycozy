import { invoke } from '@tauri-apps/api/core'; // Tauri v2 기준 (v1이면 '@tauri-apps/api'에서 가져옵니다)
import './styles.css';
import { initApp } from './main/app';

// ✅ 업데이트 확인 및 실행 함수
async function checkAndUpdateApp() {
  try {
    console.log("업데이트 확인 중...");
    
    // Rust 쪽에 만들어둔 커맨드 호출 (시간이 조금 걸릴 수 있음)
    const result = await invoke<string>('check_and_update');
    console.log("업데이트 결과:", result);

    // Rust 코드에서 반환한 문자열에 "업데이트 완료"가 포함되어 있다면
    if (result.includes("업데이트 완료")) {
      alert("새 버전 다운로드 및 교체가 완료되었습니다!\n적용을 위해 앱을 닫습니다. 다시 실행해주세요.");
      
      // 앱을 강제로 종료해서 사용자가 다시 켜도록 유도 (Tauri v2 기준)
      // import { exit } from '@tauri-apps/plugin-process'; 
      // await exit(0); 
    }
  } catch (error) {
    // 인터넷 연결이 없거나 깃허브 API 제한에 걸렸을 때 앱이 죽지 않도록 예외 처리
    console.error("업데이트 확인 실패:", error);
  }
}

// 1. 기존 앱 초기화 로직 (UI 먼저 렌더링)
initApp();

// 2. 초기화 직후 백그라운드에서 업데이트 체크 실행
checkAndUpdateApp();