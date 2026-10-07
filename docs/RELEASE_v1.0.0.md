# Zotero Context Search v1.0.0

## English

- Search metadata and indexed PDF text in Zotero's existing search box, with highlighted passages and title, author, year, and journal details.
- Display matching physical PDF pages or ranges as `PDF p. 3` or `PDF pp. 3–4` from the existing text cache. Click a page label to open Zotero's PDF reader at the first matching page. Unavailable or inconsistent page information falls back to **PDF text**.
- Provide a complete Korean or English interface based on Zotero's application language at startup. Other languages use English. Bibliographic metadata and the CSL citation language remain unchanged.
- Open a reference's attachment from its title, or use **Show in Library** to select the reference while preserving the native sort and collection.
- Includes phrase/date-added sorting, `★` favorites, configurable short and long citations, and original-file copying. No AI service, PDF reparsing, or reindexing is required.

Install `zotero-context-search-1.0.0.xpi` through **Tools → Plugins → gear → Install Plugin From File**. The accompanying `.sha256` file contains the package checksum; `updates.json` is update metadata.

Installation is allowed on Zotero **9.0+**. Desktop validation uses **Zotero 10.0.5 on Windows**. See [verification](https://github.com/git-jiwon/zotero-context-search/blob/main/docs/VERIFICATION.md) for the current package's checks and platform limits.

## 한국어

- 기존 Zotero 검색창에서 서지정보와 색인된 PDF 본문을 검색하고, 일치 문맥과 제목·저자·연도·저널명을 표시합니다.
- 기존 텍스트 캐시에서 일치하는 PDF 페이지 또는 범위를 `PDF p. 3`, `PDF pp. 3–4` 형식으로 표시합니다. 클릭하면 Zotero PDF 리더의 첫 일치 페이지로 이동합니다. 페이지 정보를 확인할 수 없거나 통계가 맞지 않으면 **PDF 본문**으로 표시합니다.
- 시작 시 Zotero 앱 언어에 따라 화면 전체를 한국어 또는 영어로 표시합니다. 다른 언어에서는 영어를 사용합니다. 서지정보와 CSL 인용 언어는 바뀌지 않습니다.
- 제목을 클릭하면 첨부파일을 엽니다. **서지목록에서 보기**는 기존 정렬과 컬렉션을 유지하면서 해당 문헌을 선택합니다.
- 정확도·추가일 정렬, `★` 즐겨찾기, 짧은·긴 인용 설정, 원본 파일 복사를 포함합니다. AI 서비스나 PDF 재분석·재색인을 실행하지 않습니다.

XPI를 내려받아 **도구 → 플러그인 → 톱니바퀴 → 파일에서 플러그인 설치**로 설치하세요. Zotero 9.0 이상에 설치할 수 있으며, 실행 검증 환경은 Windows의 Zotero 10.0.5입니다. 페이지 번호는 인쇄된 쪽 번호가 아닌 PDF 파일의 물리적 순서입니다.
