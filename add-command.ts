#!/usr/bin/env bun

// CLI 도구: .command 파일을 포트 관리 프로그램에 추가
// 사용법: bun add-command.ts <파일경로> [프로젝트이름]

import { join } from "node:path";

const PORTS_DATA_FILE = join(import.meta.dir, ".ports.json");
const API_URL = "http://localhost:3001";

async function loadPortsData() {
  try {
    const file = Bun.file(PORTS_DATA_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch (error) {
    console.error("데이터 로드 실패:", error);
  }
  return [];
}

async function savePortsData(data: any) {
  try {
    await Bun.write(PORTS_DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error("데이터 저장 실패:", error);
    return false;
  }
}

async function detectPort(filePath: string): Promise<number | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      console.error(`파일을 찾을 수 없습니다: ${filePath}`);
      return null;
    }

    const content = await file.text();

    // localhost:포트 패턴 검색
    const localhostMatch = content.match(/localhost:(\d+)/);
    if (localhostMatch?.[1]) {
      return parseInt(localhostMatch[1], 10);
    }

    // PORT=포트 또는 port=포트 패턴 검색
    const portMatch = content.match(/(?:PORT|port)\s*=\s*(\d+)/);
    if (portMatch?.[1]) {
      return parseInt(portMatch[1], 10);
    }

    return null;
  } catch (error) {
    console.error("포트 감지 실패:", error);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];

  if (!filePath) {
    console.log(`
📦 포트 관리 프로그램 - 명령어 파일 추가 도구

사용법:
  bun add-command.ts <파일경로> [프로젝트이름]

예시:
  bun add-command.ts ./실행.command
  bun add-command.ts ./실행.command "내 프로젝트"

또는 드래그앤드롭으로 사용하려면:
  .command 파일을 이 스크립트 위에 드래그하세요!
    `);
    process.exit(1);
  }

  // 파일 경로에서 프로젝트 이름 추출 (제공되지 않은 경우)
  const projectName: string =
    args[1] ?? (filePath.split('/').pop()?.replace('.command', '') || 'Unknown');

  console.log(`\n📁 파일: ${filePath}`);
  console.log(`📝 프로젝트: ${projectName}\n`);

  // 포트 감지
  console.log("🔍 포트 번호 감지 중...");
  const detectedPort = await detectPort(filePath);

  if (!detectedPort) {
    console.log("⚠️  포트 번호를 자동으로 감지하지 못했습니다.");
    console.log("수동으로 포트 번호를 입력하세요:");

    const portInput = prompt("포트 번호: ");
    if (!portInput || isNaN(parseInt(portInput))) {
      console.error("❌ 유효한 포트 번호가 필요합니다.");
      process.exit(1);
    }

    const port = parseInt(portInput);
    await addToPortManager(projectName, port, filePath);
  } else {
    console.log(`✅ 감지된 포트: ${detectedPort}`);
    await addToPortManager(projectName, detectedPort, filePath);
  }
}

async function addToPortManager(name: string, port: number, commandPath: string) {
  try {
    // 기존 데이터 로드
    const ports = await loadPortsData();

    // commandPath에서 폴더 경로 자동 추출
    let folderPath: string | undefined = undefined;
    const lastSlashIndex = commandPath.lastIndexOf('/');
    if (lastSlashIndex !== -1) {
      folderPath = commandPath.substring(0, lastSlashIndex);
    }

    // 새 항목 추가
    const newPort = {
      id: Date.now().toString(),
      name,
      port,
      commandPath,
      folderPath,
      isRunning: false,
    };

    ports.push(newPort);

    // 데이터 저장
    const success = await savePortsData(ports);

    if (success) {
      console.log("\n✅ 포트 관리 프로그램에 추가되었습니다!");
      console.log(`   이름: ${name}`);
      console.log(`   포트: ${port}`);
      console.log(`   Command 경로: ${commandPath}`);
      if (folderPath) {
        console.log(`   폴더 경로: ${folderPath}`);
      }
      console.log("\n🌐 브라우저에서 http://localhost:9000 을 열어보세요!");
    } else {
      console.error("❌ 저장에 실패했습니다.");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ 오류:", error);
    process.exit(1);
  }
}

main();
