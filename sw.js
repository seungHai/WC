// 대똥여지도 서비스 워커
// 항상 네트워크(최신 배포본)를 먼저 사용하고, 오프라인일 때만 마지막으로 받아둔 파일을 사용한다.
// → 배포 후 "수정했는데 안 바뀜" 문제가 생기지 않도록 캐시 우선 전략은 쓰지 않음
const CACHE_NAME = 'wc-map-v1';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    // 지도 타일, 카카오, Supabase 등 외부 요청은 건드리지 않음
    if (new URL(req.url).origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            const res = await fetch(req, { cache: 'no-cache' });
            if (res && res.ok) {
                const cache = await caches.open(CACHE_NAME);
                cache.put(req, res.clone());
            }
            return res;
        } catch (err) {
            const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
            if (cached) return cached;
            if (req.mode === 'navigate') {
                const home = await caches.match('./');
                if (home) return home;
            }
            throw err;
        }
    })());
});
