import { invoke } from '@tauri-apps/api/core';
import './styles.css';
import { initApp } from './main/app';

// ✅ 1. 화면 우측 하단에 알림(Toast)을 띄우는 함수
function showUpdateToast(message: string, autoHide: boolean = false) {
  let toast = document.getElementById('update-toast');
  
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'update-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'; // 글씨가 잘 보이게 배경을 조금 더 진하게
    toast.style.color = '#fff';
    toast.style.padding = '16px 20px'; // 에러가 길어질 수 있으니 패딩을 넉넉하게
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.zIndex = '9999';
    toast.style.fontFamily = 'sans-serif';
    toast.style.fontSize = '14px';
    toast.style.lineHeight = '1.5';
    toast.style.transition = 'opacity 0.3s';
    toast.style.whiteSpace = 'pre-wrap'; // 줄바꿈(\n)이 정상적으로 보이도록 추가
    document.body.appendChild(toast);
  }

  toast.innerText = message;
  toast.style.opacity = '1';

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
    const toast = showUpdateToast("🔄 새 버전을 확인하고 다운로드 중입니다...");
    
    const result = await invoke<string>('check_and_update');
    
    if (result.includes("업데이트 완료")) {
      showUpdateToast("✅ 업데이트 완료! 적용을 위해 앱을 재시작해주세요.");
      
      setTimeout(() => {
        alert("새 버전 다운로드 및 교체가 완료되었습니다!\n적용을 위해 앱을 닫습니다. 다시 실행해주세요.");
      }, 500);
    } else {
      toast.style.opacity = '0'; // 최신 버전이면 조용히 숨김
    }
  } catch (error) {
    console.error("업데이트 에러:", error);
    
    const errMsg = String(error);
    
    // 맥(Mac) 로컬 개발 환경에서 발생하는 '파일 없음' 에러는 조용히 넘깁니다.
    if (errMsg.includes("No asset found for target")) {
        const toast = document.getElementById('update-toast');
        if (toast) toast.style.opacity = '0';
        return;
    }

    // 🚨 핵심 수정: 씹히는 alert 대신, 까만 토스트 창에 에러 원본을 그대로 노출!
    // autoHide를 false로 두어 사용자가 끌 때까지(또는 앱을 닫을 때까지) 사라지지 않습니다.
    showUpdateToast(`❌ 업데이트 실패 원인:\n${errMsg}`, false);
  }
}

// 앱 UI 먼저 렌더링
initApp();

// 렌더링 직후 업데이트 로직 백그라운드 실행
checkAndUpdateApp();