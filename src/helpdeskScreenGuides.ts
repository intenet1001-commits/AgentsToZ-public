/** Reviewed guidance only; never contains QR payloads or claims a live connection. */
export const HELPDESK_SCREEN_GUIDES = {
  nearby: {
    label: '같은 Wi-Fi에서 처음 연결', title: 'iPad·iPhone에서 Mac 화면 연결',
    steps: [
      'Mac과 iPad·iPhone을 같은 개인 Wi-Fi에 연결하세요. 두 기기의 AgentsToZ 앱을 호환되는 최신 버전으로 업데이트합니다.',
      'Mac의 AgentsToZ Screen에서 화면 기록·손쉬운 사용·Mac 입력 우선 보호 권한을 확인하고 기기 등록 QR을 여세요. 프로젝트·워크룸 연결용 QR과 Mac 화면 등록 QR은 서로 달라요.',
      'iPad·iPhone 카메라로 방금 연 QR을 찍어 AgentsToZ 앱을 열거나, 앱의 Mac 화면 목록에서 「Mac 화면 등록 · QR 스캔」을 눌러 스캔하세요. QR 사진이나 등록 비밀을 채팅에 올릴 필요는 없어요.',
      '두 화면에 표시된 확인 내용을 비교하고, 요청한 지문·Face ID 인증은 본인이 완료하세요. 잠겨 있거나 인증 시간이 지났다면 화면을 깨운 뒤 다시 인증합니다.',
      '등록한 Mac을 열고 실제 화면이 보이는지 확인하세요. 작은 버튼은 입력 방식을 트랙패드로 바꾸어 커서를 이동한 뒤 탭하면 누르기 쉬워요. 한 번 클릭해 Mac에 반영되는지 확인하면 됩니다.',
    ],
  },
  qr: {
    label: '“화면 등록 QR이 아닙니다”', title: 'QR 등록 오류부터 확인하기',
    steps: [
      'QR을 만든 곳부터 확인해요. Mac의 AgentsToZ Screen 기기 등록 화면에 나온 QR인지 확인하세요. 프로젝트·워크룸 QR이나 Cloudflare 조직 QR은 여기서 등록하지 않습니다.',
      '맞는 QR인데도 “화면 등록 QR이 아닙니다”라고 나오면 두 앱의 버전을 확인하세요. 오래된 iPad·iPhone 앱이 새 Mac QR 형식을 읽지 못할 수 있어요. 카메라에 “사용 가능한 데이터가 없음”이 뜨는 것도 카메라로 열 수 있는 앱 버전이 아니라는 뜻이에요. 먼저 앱을 업데이트하고 같은 화면에서 다시 스캔하거나, 앱 안의 「Mac 화면 등록 · QR 스캔」으로 찍습니다.',
      'QR 전체가 카메라에 들어오게 맞추세요. 이미 사용했거나 만료된 QR이면 Mac에서 새 등록 QR을 열고 스캔합니다. 기존 등록과 키를 모두 지우거나 초기화할 필요는 없어요.',
      '오류가 계속되면 Mac과 iPad·iPhone의 앱 버전, 멈춘 단계, 오류 문구만 알려 주세요. QR 원문·등록 비밀·지문 정보는 보내지 않습니다.',
    ],
  },
  internet: {
    label: 'LTE·외부에서 연결 준비', title: 'Cloudflare 사설망 연결 준비',
    steps: [
      '먼저 같은 Wi-Fi에서 Mac 화면 등록과 실제 조작을 확인하세요. 등록된 Mac의 신원과 앱 인증은 외부 연결에서도 필요합니다.',
      '대상 Mac의 Cloudflare 터널과 본인 기기 등록 정책을 준비합니다. 화면 제어 포트만 허용하고, 이 Mac 주소 하나만 사설망 경로에 포함하도록 설정합니다. 터널의 Healthy 표시는 Mac 쪽 경로가 준비됐다는 뜻이에요.',
      '새 iPad·iPhone마다 Cloudflare One Agent를 한 번 설치하고 본인 조직으로 로그인하세요. VPN 프로필 설치와 OS 승인은 본인이 처리합니다. 새 기기를 쓸 때 계정·터널 전체를 다시 만드는 것은 아니에요.',
      '집의 Wi-Fi로 돌아와도 Cloudflare One Agent가 켜져 있으면 사설망 IP 연결이 Cloudflare를 거칠 수 있어요. 같은 Wi-Fi라는 사실만으로 직접 연결이라고 판단하지 않으며, 앱의 실제 경로와 화면 반응을 확인합니다.',
      '사설망 연결 설정을 지원하는 AgentsToZ 앱 버전에서 등록한 Mac의 사설망 주소를 설정하고 해당 경로를 선택하세요. 이 메뉴가 없으면 앱 업데이트가 필요하며, Cloudflare 로그인만으로 앱 연결이 완료되지는 않습니다.',
      'Wi-Fi를 끄고 LTE·셀룰러에서 실제 Mac 화면과 클릭을 확인하세요. 전환 중 끊어짐·다시 인증·화면 지연도 확인합니다. 근거리 성공이나 터널 Healthy만으로 이 단계가 완료된 것은 아니에요.',
    ],
  },
  remove: {
    label: '지운 기기가 Mac에 남아 있어요', title: '목록 삭제와 등록 해지',
    steps: [
      'iPad·iPhone 목록에서 Mac을 지우는 것과 Mac이 허용한 기기의 등록 해지는 달라요. 목록을 지웠어도 Mac의 등록 권한은 남아 있을 수 있습니다.',
      'Mac 메뉴 막대의 AgentsToZ Screen → 등록된 기기에서 해당 기기를 확인하고 등록 해지를 선택하세요. 등록된 기기 수는 지금 화면에 연결된 기기 수와 다를 수 있어요.',
      '다시 쓰려면 새 QR로 등록합니다. 다른 이름이나 오래된 항목을 보고 같은 기기라고 추측해 여러 등록을 한꺼번에 지우지 마세요.',
    ],
  },
} as const;
export type HelpdeskScreenGuide = keyof typeof HELPDESK_SCREEN_GUIDES;
