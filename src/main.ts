import { invoke } from '@tauri-apps/api/core';
import './styles.css';
import { initApp } from './main/app';

// ✅ 1. 화면 우측 하단에 알림(Toast)을 띄우는 함수
function showUpdateToast(message: string, autoHide: boolean = false) {
  // 이미 알림창이 있다면 내용을 업데이트
  let toast = document.getElementById('update-toast');
  
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'update-toast';
    // 알림창 스타일링 (원하는 대로 CSS 수정 가능)
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    toast.style.zIndex = '9999';
    toast.style.fontFamily = 'sans-serif';
    toast.style.fontSize = '14px';
    toast.style.transition = 'opacity 0.3s';
    document.body.appendChild(toast);
  }

  toast.innerText = message;
  toast.style.opacity = '1';

  // autoHide가 true면 3초 뒤에 사라짐
  if (autoHide) {
    setTimeout(() => {
      if (toast) toast.style.opacity = '0';
    }, 3000);
  }

  return toast;
}

// ✅ 2. 업데이트 확인 및 진행 로직
async function checkAndUpdateApp() {
  try {
    // 업데이트 시작 시 사용자에게 알림 (사라지지 않고 계속 떠있음)
    const toast = showUpdateToast("🔄 새 버전을 확인하고 다운로드 중입니다...");
    
    // Rust의 check_and_update 함수 호출 (이 동안 백그라운드에서 다운로드 진행)
    const result = await invoke<string>('check_and_update');
    
    if (result.includes("업데이트 완료")) {
      // 다운로드가 완료되면 알림 내용 변경
      showUpdateToast("✅ 업데이트 완료! 적용을 위해 앱을 재시작해주세요.");
      
      // 사용자에게 확실히 인지시키기 위해 alert 창도 띄움
      setTimeout(() => {
        alert("새 버전 다운로드 및 교체가 완료되었습니다!\n적용을 위해 앱을 닫습니다. 다시 실행해주세요.");
      }, 500);
    } else {
      // 이미 최신 버전이라면 조용히 알림창 숨기기
      toast.style.opacity = '0';
    }
  } catch (error) {
    console.error("업데이트 에러:", error);
    // 에러 발생 시 3초간 에러 메시지 띄웠다가 숨김
    showUpdateToast("❌ 업데이트 확인 중 오류가 발생했습니다.", true);
  }
}

// 앱 UI 먼저 렌더링
initApp();

// 렌더링 직후 업데이트 로직 백그라운드 실행
checkAndUpdateApp();