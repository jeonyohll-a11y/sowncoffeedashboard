# Cloudflare Pages 배포 방법

이 프로젝트는 Cloudflare Pages에 배포하는 정적 대시보드입니다. 화면은 `netlify-site`에서 제공되고, API는 `functions/api`의 Pages Functions가 `/api/beans`, `/api/translate`로 동작합니다.

## 로컬 실행

```bash
cd "green-bean-finder-netlify"
npm install
npm run start
```

정상 실행되면 Wrangler가 알려주는 로컬 주소를 엽니다. 아래 API가 응답하면 대시보드도 데이터를 불러옵니다.

- `/api/beans?page=1`
- `/api/translate`

## Cloudflare 화면에서 배포

GitHub 저장소를 Cloudflare Pages에 연결했다면 아래처럼 설정합니다.

1. Cloudflare 대시보드에서 `Workers & Pages`로 갑니다.
2. `Create application` 또는 기존 Pages 프로젝트를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. 빌드 설정을 아래처럼 맞춥니다.
   - Framework preset: `None`
   - Root directory: `green-bean-finder-netlify`
   - Build command: 비워두기
   - Build output directory: `netlify-site`
5. 저장 후 배포합니다.

저장소 루트 자체가 `green-bean-finder-netlify`라면 Root directory는 비워둡니다.

## 터미널에서 배포

```bash
cd "green-bean-finder-netlify"
npm run deploy
```

프로젝트 이름을 바꾸려면 `package.json`의 `--project-name green-bean-finder` 값을 원하는 Cloudflare Pages 프로젝트명으로 바꿉니다.

## 환경 변수

번역 기능을 쓰려면 Cloudflare Pages 프로젝트의 `Settings > Environment variables`에 아래 값을 추가합니다.

```dotenv
DEEPL_API_KEY=your_deepl_key
```

DeepL Free 키는 보통 `:fx`로 끝납니다. 코드가 Free 키면 `api-free.deepl.com`, Pro 키면 `api.deepl.com`을 자동으로 선택합니다.

## 배포 후 확인

배포가 끝나면 아래 주소를 확인합니다.

- `/`
- `/api/beans?page=1`
- `/api/translate`

첫 화면은 뜨는데 데이터가 비어 있으면 대부분 Pages Functions가 배포 루트에서 발견되지 않은 경우입니다. 이때는 Cloudflare의 Root directory가 `green-bean-finder-netlify`인지, 그리고 `functions/api/beans.js`가 저장소에 올라갔는지 확인합니다.
