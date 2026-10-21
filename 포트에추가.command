#!/bin/bash

# 현재 스크립트 디렉토리로 이동
cd "$(dirname "$0")"

echo "======================================"
echo "  📦 포트 관리 프로그램에 파일 추가"
echo "======================================"
echo ""

# 인자로 파일이 전달되었는지 확인 (드래그앤드롭)
if [ $# -gt 0 ]; then
    for file in "$@"; do
        if [[ "$file" == *.command ]] || [[ "$file" == *.sh ]]; then
            echo "추가 중: $file"
            bun add-command.ts "$file"
        else
            echo "⚠️  건너뜀 (지원되지 않는 파일): $file"
        fi
    done
else
    # 대화형 모드
    echo "📁 .command 파일의 전체 경로를 입력하거나"
    echo "   이 창으로 파일을 드래그하세요:"
    echo ""
    read -p "파일 경로: " filepath

    # 공백 제거
    filepath=$(echo "$filepath" | xargs)

    if [ -z "$filepath" ]; then
        echo "❌ 경로가 입력되지 않았습니다."
        exit 1
    fi

    # 따옴표 제거
    filepath="${filepath//\'/}"
    filepath="${filepath//\"/}"

    echo ""
    read -p "프로젝트 이름 (선택사항): " projectname

    if [ -z "$projectname" ]; then
        bun add-command.ts "$filepath"
    else
        bun add-command.ts "$filepath" "$projectname"
    fi
fi

echo ""
echo "======================================"
read -p "종료하려면 Enter를 누르세요..."
