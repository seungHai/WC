/**
 * 대똥여지도 (WC Map) v2.0 - 메인 애플리케이션 컨트롤러
 */
(function () {
    const state = {
        engine: 'ol', // 'kakao' | 'ol'
        kakaoMap: null,
        map: null,
        restrooms: [],
        filteredRestrooms: [],
        markerOverlays: [],
        userMarkerOverlay: null,
        pickMarkerOverlay: null,
        userLocation: null, // [lng, lat]
        selectedId: null,
        activeFilter: 'all', // 'all' | 'nearest' | 'separated' | 'floor1' | 'fav'
        activeRegion: 'all',
        searchQuery: '',
        isPickingLocation: false,
        pickPlaceName: '', // 위치 찍기 중 검색으로 고른 장소명 (장소명 칸이 비어있으면 자동 입력)
        sheetState: 'collapsed', // 모바일 바텀시트: 'collapsed' | 'half' | 'expanded'
        editingRestroomId: null,
        adminUsersCache: [],
        lastCreatedCredentials: {} // username -> plainPassword (세션 내 안내 문구 복사용)
    };

    // ========================================================================
    // 유틸리티 함수 (거리 계산, 클립보드 복사, 토스트 알림, XSS 방지)
    // ========================================================================
    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function showToast(message) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transition = 'opacity 0.25s ease';
            setTimeout(() => el.remove(), 260);
        }, 2400);
    }

    async function copyText(text, label = '복사되었습니다!') {
        try {
            await navigator.clipboard.writeText(text);
            showToast(`📋 ${label}`);
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showToast(`📋 ${label}`);
        }
    }

    // 하버사인(Haversine) 직선거리 계산 (미터 단위 반환)
    function getDistanceMeters(lng1, lat1, lng2, lat2) {
        const R = 6371000;
        const toRad = deg => (deg * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function formatDistance(meters) {
        if (meters === null || meters === undefined || Number.isNaN(meters)) return '';
        if (meters < 1000) {
            return `${Math.round(meters)}m`;
        }
        return `${(meters / 1000).toFixed(1)}km`;
    }

    function formatWalkingTime(meters) {
        if (meters === null || meters === undefined || Number.isNaN(meters)) return '';
        // 도보 평균 분속 67m 기준
        const mins = Math.max(1, Math.round(meters / 67));
        return `도보 약 ${mins}분`;
    }

    // ========================================================================
    // 다크 모드 테마 관리
    // ========================================================================
    function initTheme() {
        const savedTheme = localStorage.getItem('wc_theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
        updateThemeButton(savedTheme);
    }

    function toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('wc_theme', next);
        updateThemeButton(next);
    }

    function updateThemeButton(theme) {
        const btn = document.getElementById('btn-theme-toggle');
        if (btn) {
            btn.textContent = theme === 'dark' ? '☀️ 라이트' : '🌙 다크';
        }
    }

    // ========================================================================
    // 인증 & 세션 흐름 제어
    // ========================================================================
    function updateAuthModeBadge() {
        const badge = document.getElementById('auth-mode-badge');
        if (!badge) return;
        if (window.WCDB.isCloudMode()) {
            badge.className = 'auth-mode-badge cloud';
            badge.innerHTML = '🟢 클라우드 보안 인증 연동됨';
        } else {
            badge.className = 'auth-mode-badge';
            badge.innerHTML = '🔒 보안 회원제 로그인 (초기 관리자: admin / admin1234)';
        }
    }

    async function checkInitialAuth() {
        updateAuthModeBadge();
        const user = await window.WCDB.verifySession();
        if (user) {
            await enterApp(user);
        } else {
            showLoginScreen();
        }
    }

    function showLoginScreen() {
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('app-shell').style.display = 'none';
        updateAuthModeBadge();
    }

    async function enterApp(user) {
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app-shell').style.display = 'flex';

        // 상단 사용자 상태 업데이트
        const roleEl = document.getElementById('user-role-badge');
        const nameEl = document.getElementById('user-display-name');
        const adminBtn = document.getElementById('btn-open-admin');

        if (roleEl) {
            roleEl.textContent = user.role === 'admin' ? '관리자' : '정회원';
            roleEl.className = 'role-badge ' + (user.role === 'admin' ? 'admin' : '');
        }
        if (nameEl) {
            nameEl.textContent = `${user.display_name} (${user.username})`;
        }
        if (adminBtn) {
            adminBtn.style.display = user.role === 'admin' ? 'inline-flex' : 'none';
        }

        // 지도 최초 초기화 및 리사이즈 보장
        if (!state.kakaoMap && !state.map) {
            await initMap();
        } else {
            refreshMapSize();
        }

        await loadRestrooms();
    }

    // ========================================================================
    // 카카오맵(Kakao Maps SDK) 우선 초기화 + 폴백 하이브리드 지도 엔진
    // ========================================================================
    function getKakaoAppKey() {
        const saved = (localStorage.getItem('wc_kakao_app_key') || '').trim();
        const cfg = (window.WC_CONFIG && window.WC_CONFIG.KAKAO_MAP_APP_KEY || '').trim();
        return saved || cfg;
    }

    function refreshMapSize() {
        setTimeout(() => {
            if (state.engine === 'kakao' && state.kakaoMap) {
                state.kakaoMap.relayout();
            } else if (state.map) {
                state.map.updateSize();
            }
        }, 60);
    }

    function getMapCenterLonLat() {
        if (state.engine === 'kakao' && state.kakaoMap) {
            const c = state.kakaoMap.getCenter();
            return [c.getLng(), c.getLat()];
        }
        if (state.map) {
            return ol.proj.toLonLat(state.map.getView().getCenter());
        }
        return (window.WC_CONFIG && window.WC_CONFIG.DEFAULT_CENTER) || [126.742887, 37.5205];
    }

    function getMapZoom() {
        if (state.engine === 'kakao' && state.kakaoMap) {
            return 20 - state.kakaoMap.getLevel();
        }
        if (state.map) {
            return state.map.getView().getZoom() || 16;
        }
        return 16;
    }

    function moveMapTo(lng, lat, olZoom = 16) {
        if (state.engine === 'kakao' && state.kakaoMap) {
            const kakaoLevel = Math.max(1, Math.min(13, Math.round(20 - olZoom)));
            const moveLatLon = new kakao.maps.LatLng(lat, lng);
            state.kakaoMap.setLevel(kakaoLevel);
            state.kakaoMap.panTo(moveLatLon);
            return;
        }
        if (state.map) {
            state.map.getView().animate({
                center: ol.proj.fromLonLat([lng, lat]),
                zoom: olZoom,
                duration: 400
            });
        }
    }

    function panMapTo(lng, lat) {
        if (state.engine === 'kakao' && state.kakaoMap) {
            state.kakaoMap.panTo(new kakao.maps.LatLng(lat, lng));
            return;
        }
        if (state.map) {
            state.map.getView().animate({
                center: ol.proj.fromLonLat([lng, lat]),
                duration: 250
            });
        }
    }

    function zoomMapBy(delta) {
        if (state.engine === 'kakao' && state.kakaoMap) {
            const curLevel = state.kakaoMap.getLevel();
            const nextLevel = Math.max(1, Math.min(13, curLevel - delta));
            state.kakaoMap.setLevel(nextLevel, { animate: true });
            return;
        }
        if (state.map) {
            const curZoom = state.map.getView().getZoom() || 16;
            state.map.getView().animate({
                zoom: Math.max(7, Math.min(19, curZoom + delta)),
                duration: 200
            });
        }
    }

    function loadKakaoSdkScript(appKey) {
        return new Promise((resolve) => {
            if (window.kakao && window.kakao.maps) {
                window.kakao.maps.load(() => resolve(true));
                return;
            }
            const script = document.createElement('script');
            script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&libraries=services&autoload=false`;
            script.onload = () => {
                if (window.kakao && window.kakao.maps) {
                    window.kakao.maps.load(() => resolve(true));
                } else {
                    resolve(false);
                }
            };
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    }

    const MAP_TILE_SOURCES = {
        voyager: () => new ol.source.XYZ({
            url: 'https://{a-d}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
            tilePixelRatio: 2,
            attributions: '© OpenStreetMap contributors, © CARTO'
        }),
        detailed: () => new ol.source.XYZ({
            url: 'https://{a-c}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
            attributions: '© OpenStreetMap contributors, Tiles style by HOT'
        }),
        satellite: () => new ol.source.XYZ({
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            attributions: '© Esri'
        })
    };

    async function initMap() {
        const mapEl = document.getElementById('map');
        if (!mapEl) return;

        const defaultCenter = (window.WC_CONFIG && window.WC_CONFIG.DEFAULT_CENTER) || [126.742887, 37.5205];
        const defaultZoom = (window.WC_CONFIG && window.WC_CONFIG.DEFAULT_ZOOM) || 16;

        const kakaoKey = getKakaoAppKey();
        if (kakaoKey && window.location.protocol !== 'file:') {
            const loaded = await loadKakaoSdkScript(kakaoKey);
            if (loaded && window.kakao && window.kakao.maps) {
                try {
                    mapEl.innerHTML = '';
                    state.engine = 'kakao';
                    const kakaoLevel = Math.max(1, Math.min(13, Math.round(20 - defaultZoom)));
                    state.kakaoMap = new kakao.maps.Map(mapEl, {
                        center: new kakao.maps.LatLng(defaultCenter[1], defaultCenter[0]),
                        level: kakaoLevel
                    });

                    if (typeof ResizeObserver !== 'undefined') {
                        const ro = new ResizeObserver(() => {
                            if (state.kakaoMap) state.kakaoMap.relayout();
                        });
                        ro.observe(mapEl);
                    }

                    kakao.maps.event.addListener(state.kakaoMap, 'click', function (mouseEvent) {
                        if (state.isPickingLocation) {
                            // 위치 찍기 모드: 탭한 지점으로 중앙 핀을 이동 (확정은 하단 버튼으로)
                            const latlng = mouseEvent.latLng;
                            panMapTo(latlng.getLng(), latlng.getLat());
                        }
                    });

                    kakao.maps.event.addListener(state.kakaoMap, 'center_changed', updatePickCoordReadout);

                    kakao.maps.event.addListener(state.kakaoMap, 'idle', function () {
                        renderMapMarkers();
                    });

                    renderRegionBar();
                    initMapStyleSwitcher();
                    return;
                } catch (err) {
                    console.warn('카카오맵 초기화 실패, 기본 지도 엔진으로 폴백합니다:', err);
                }
            }
        }

        // 카카오 키 미입력 또는 로컬 file:// 프로토콜 접속 시 폴백 엔진 작동
        state.engine = 'ol';
        mapEl.innerHTML = '';
        state.baseTileLayer = new ol.layer.Tile({
            source: MAP_TILE_SOURCES.voyager()
        });

        state.map = new ol.Map({
            target: 'map',
            layers: [state.baseTileLayer],
            view: new ol.View({
                center: ol.proj.fromLonLat(defaultCenter),
                zoom: defaultZoom,
                minZoom: 7,
                maxZoom: 19
            })
        });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                if (state.map) state.map.updateSize();
            });
            ro.observe(mapEl);
        }
        setTimeout(() => {
            if (state.map) state.map.updateSize();
        }, 120);

        state.map.on('click', async function (evt) {
            if (state.isPickingLocation) {
                // 위치 찍기 모드: 탭한 지점으로 중앙 핀을 이동 (확정은 하단 버튼으로)
                const lonLat = ol.proj.toLonLat(evt.coordinate);
                panMapTo(lonLat[0], lonLat[1]);
            }
        });

        state.map.getView().on('change:center', updatePickCoordReadout);

        state.map.on('moveend', function () {
            renderMapMarkers();
        });

        renderRegionBar();
        initMapStyleSwitcher();
    }

    function initMapStyleSwitcher() {
        const switcher = document.getElementById('map-style-bar');
        if (!switcher) return;
        switcher.querySelectorAll('[data-map-style]').forEach(btn => {
            btn.onclick = () => {
                const styleKey = btn.getAttribute('data-map-style');
                switcher.querySelectorAll('[data-map-style]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                if (state.engine === 'kakao' && state.kakaoMap) {
                    if (styleKey === 'voyager') {
                        state.kakaoMap.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
                    } else if (styleKey === 'detailed') {
                        state.kakaoMap.setMapTypeId(kakao.maps.MapTypeId.HYBRID);
                    } else if (styleKey === 'satellite') {
                        state.kakaoMap.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
                    }
                    return;
                }

                if (MAP_TILE_SOURCES[styleKey] && state.baseTileLayer) {
                    state.baseTileLayer.setSource(MAP_TILE_SOURCES[styleKey]());
                }
            };
        });
    }

    function renderRegionBar() {
        const container = document.getElementById('region-bar');
        if (!container || !window.WC_CONFIG) return;

        container.innerHTML = window.WC_CONFIG.REGIONS.map(r => {
            // 해당 지역에 등록된 화장실 개수 표시
            let count = state.restrooms.length;
            if (r.id !== 'all' && r.keyword) {
                const regex = new RegExp(r.keyword, 'i');
                count = state.restrooms.filter(item => regex.test(`${item.region || ''} ${item.name || ''} ${item.location_detail || ''}`)).length;
            }
            const countBadge = count > 0 ? `<span style="opacity:0.75; font-size:11px; margin-left:2px;">(${count})</span>` : '';
            return `
                <button type="button" class="region-btn ${state.activeRegion === r.id ? 'active' : ''}" data-region="${r.id}">
                    ${escapeHtml(r.label)}${countBadge}
                </button>
            `;
        }).join('');

        container.querySelectorAll('.region-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const regionId = btn.getAttribute('data-region');
                const region = window.WC_CONFIG.REGIONS.find(item => item.id === regionId);
                if (!region) return;

                state.activeRegion = regionId;
                recalculateDistancesAndFilter();

                // 해당 지역에 마커가 있으면 첫 번째(또는 중심) 마커로 이동, 없으면 지역 기본 좌표로 이동
                if (regionId !== 'all' && state.filteredRestrooms.length > 0) {
                    const target = state.filteredRestrooms[0];
                    moveMapTo(target.lng, target.lat, state.filteredRestrooms.length === 1 ? 16 : 15);
                } else {
                    moveMapTo(region.coords[0], region.coords[1], region.zoom);
                }
            });
        });
    }

    async function loadRestrooms() {
        try {
            const list = await window.WCDB.getRestrooms();
            state.restrooms = (list && list.length > 0)
                ? list
                : ((window.WC_CONFIG && window.WC_CONFIG.INITIAL_RESTROOMS) || []);
            recalculateDistancesAndFilter();
        } catch (err) {
            state.restrooms = (window.WC_CONFIG && window.WC_CONFIG.INITIAL_RESTROOMS) || [];
            recalculateDistancesAndFilter();
        }
    }

    function recalculateDistancesAndFilter() {
        const favIds = window.WCDB.getFavorites();
        const refCoords = state.userLocation;

        // 거리 계산 및 즐겨찾기 플래그 주입
        const enriched = state.restrooms.map(item => {
            let distance = null;
            if (refCoords) {
                distance = getDistanceMeters(refCoords[0], refCoords[1], item.lng, item.lat);
            }
            return {
                ...item,
                distance,
                isFav: favIds.includes(item.id)
            };
        });

        // 검색어 필터링
        const q = state.searchQuery.trim().toLowerCase();
        let filtered = enriched.filter(item => {
            if (!q) return true;
            const hay = `${item.name} ${item.location_detail} ${item.region} ${item.note} ${item.floor}`.toLowerCase();
            return hay.includes(q);
        });

        // 광역 지역(시/도) 필터링
        if (state.activeRegion && state.activeRegion !== 'all' && window.WC_CONFIG) {
            const regObj = window.WC_CONFIG.REGIONS.find(r => r.id === state.activeRegion);
            if (regObj && regObj.keyword) {
                const regex = new RegExp(regObj.keyword, 'i');
                filtered = filtered.filter(item => regex.test(`${item.region || ''} ${item.name || ''} ${item.location_detail || ''}`));
            }
        }

        // 카테고리 칩 필터링
        if (state.activeFilter === 'separated') {
            filtered = filtered.filter(i => i.gender_separated);
        } else if (state.activeFilter === 'floor1') {
            filtered = filtered.filter(i => (i.floor || '').includes('1층'));
        } else if (state.activeFilter === 'fav') {
            filtered = filtered.filter(i => i.isFav);
        }

        // 정렬: 내 위치가 있거나 'nearest' 필터면 거리순, 아니면 즐겨찾기 우선 + 이름순
        if (refCoords || state.activeFilter === 'nearest') {
            filtered.sort((a, b) => (a.distance ?? 99999999) - (b.distance ?? 99999999));
        } else {
            filtered.sort((a, b) => {
                if (a.isFav !== b.isFav) return a.isFav ? -1 : 1;
                return a.name.localeCompare(b.name, 'ko');
            });
        }

        state.filteredRestrooms = filtered;
        renderRegionBar();
        renderRestroomList();
        renderMapMarkers();
        updateNearestBanner(enriched);
    }

    function updateNearestBanner(enrichedList) {
        const banner = document.getElementById('nearest-banner');
        if (!banner) return;

        if (!state.userLocation || enrichedList.length === 0) {
            banner.style.display = 'none';
            return;
        }

        const sorted = [...enrichedList].sort((a, b) => (a.distance ?? 99999999) - (b.distance ?? 99999999));
        const nearest = sorted[0];
        if (!nearest) {
            banner.style.display = 'none';
            return;
        }

        const pwSummary = nearest.gender_separated
            ? `남 ${nearest.pw_male || '-'} / 여 ${nearest.pw_female || '-'}`
            : `비번 ${nearest.pw_common || '개방'}`;

        banner.style.display = 'flex';
        banner.innerHTML = `
            <div class="nearest-banner-info">
                <div class="nearest-banner-tag">🚨 내 위치에서 가장 가까운 화장실</div>
                <div class="nearest-banner-title">${escapeHtml(nearest.name)} (${escapeHtml(nearest.location_detail || nearest.floor)})</div>
                <div class="nearest-banner-sub">
                    <span>${formatDistance(nearest.distance)} · ${formatWalkingTime(nearest.distance)}</span>
                    <b>${escapeHtml(pwSummary)}</b>
                </div>
            </div>
            <span class="nearest-banner-go">이동 →</span>
        `;
        banner.onclick = () => selectRestroom(nearest.id, true);
    }

    // ========================================================================
    // 좌측(모바일 하단) 리스트 및 지도 마커 렌더링
    // ========================================================================
    function renderPwBadgesHtml(item) {
        const badges = [];
        if (item.gender_separated) {
            if (item.pw_male) {
                badges.push(`
                    <span class="pw-chip male" data-copy-pw="${escapeHtml(item.pw_male)}" title="클릭하여 남자 화장실 비밀번호 복사">
                        🔵 남자 ${escapeHtml(item.pw_male)} 📋
                    </span>
                `);
            }
            if (item.pw_female) {
                badges.push(`
                    <span class="pw-chip female" data-copy-pw="${escapeHtml(item.pw_female)}" title="클릭하여 여자 화장실 비밀번호 복사">
                        🔴 여자 ${escapeHtml(item.pw_female)} 📋
                    </span>
                `);
            }
        }
        if (item.pw_common) {
            badges.push(`
                <span class="pw-chip common" data-copy-pw="${escapeHtml(item.pw_common)}" title="클릭하여 비밀번호 복사">
                    🔑 비번 ${escapeHtml(item.pw_common)} 📋
                </span>
            `);
        }
        if (badges.length === 0) {
            badges.push(`<span class="pw-chip common">🔓 비밀번호 없음 (개방)</span>`);
        }
        return badges.join('');
    }

    function renderRestroomList() {
        const listEl = document.getElementById('restroom-list');
        const countEl = document.getElementById('restroom-count');
        if (!listEl) return;

        if (countEl) {
            countEl.textContent = `총 ${state.filteredRestrooms.length}곳`;
        }

        if (state.filteredRestrooms.length === 0) {
            listEl.innerHTML = `
                <div style="text-align:center; padding:36px 16px; color:var(--text-muted); font-size:14px;">
                    조건에 맞는 화장실이 없습니다.<br>새 화장실을 직접 추가해보세요!
                </div>
            `;
            return;
        }

        listEl.innerHTML = state.filteredRestrooms.map(item => `
            <div class="restroom-card ${state.selectedId === item.id ? 'selected' : ''}" data-id="${escapeHtml(item.id)}">
                <div class="card-top-row">
                    <div class="card-title-group">
                        <div class="card-title">
                            <span>${escapeHtml(item.name)}</span>
                        </div>
                        <div class="card-subtitle">
                            ${escapeHtml(item.location_detail || '')} ${item.floor ? `· ${escapeHtml(item.floor)}` : ''}
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        ${item.distance !== null ? `<span class="distance-pill">${formatDistance(item.distance)}</span>` : ''}
                        <button type="button" class="fav-btn ${item.isFav ? 'active' : ''}" data-fav-id="${escapeHtml(item.id)}" title="즐겨찾기">
                            ${item.isFav ? '⭐' : '☆'}
                        </button>
                    </div>
                </div>
                <div class="pw-badge-row">
                    ${renderPwBadgesHtml(item)}
                </div>
                <div class="card-meta-tags">
                    <span class="meta-tag">${item.gender_separated ? '🚻 남녀분리' : '🚪 남녀공용'}</span>
                    <span class="meta-tag ${item.has_paper ? '' : 'warn'}">${item.has_paper ? '🧻 휴지 구비' : '⚠️ 휴지 개인지참!'}</span>
                    ${item.region ? `<span class="meta-tag">📍 ${escapeHtml(item.region)}</span>` : ''}
                    ${item.note ? `<span class="meta-tag">💡 ${escapeHtml(item.note)}</span>` : ''}
                </div>
            </div>
        `).join('');

        // 카드 클릭 이벤트 바인딩
        listEl.querySelectorAll('.restroom-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // 비밀번호 복사 배지 클릭 시
                const pwBtn = e.target.closest('[data-copy-pw]');
                if (pwBtn) {
                    e.stopPropagation();
                    const pw = pwBtn.getAttribute('data-copy-pw');
                    copyText(pw, `비밀번호 [${pw}] 복사 완료!`);
                    return;
                }
                // 즐겨찾기 버튼 클릭 시
                const favBtn = e.target.closest('[data-fav-id]');
                if (favBtn) {
                    e.stopPropagation();
                    const id = favBtn.getAttribute('data-fav-id');
                    const added = window.WCDB.toggleFavorite(id);
                    showToast(added ? '⭐ 즐겨찾기에 추가되었습니다.' : '즐겨찾기에서 해제되었습니다.');
                    recalculateDistancesAndFilter();
                    return;
                }
                const id = card.getAttribute('data-id');
                selectRestroom(id, true);
            });
        });
    }

    // 라벨 겹침 회피용 후보 오프셋 슬롯 (앵커 도트 기준 상/하/대각선/좌/우 방사형 배치)
    const LABEL_OFFSET_SLOTS = [
        { dx: 0, dy: -24 },
        { dx: 0, dy: 24 },
        { dx: 68, dy: -22 },
        { dx: -68, dy: -22 },
        { dx: 68, dy: 22 },
        { dx: -68, dy: 22 },
        { dx: 0, dy: -54 },
        { dx: 0, dy: 54 },
        { dx: 92, dy: 0 },
        { dx: -92, dy: 0 },
        { dx: 84, dy: -52 },
        { dx: -84, dy: -52 },
        { dx: 84, dy: 52 },
        { dx: -84, dy: 52 }
    ];

    function getOverlapArea(boxA, boxB) {
        const xOverlap = Math.max(0, Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left));
        const yOverlap = Math.max(0, Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top));
        return xOverlap * yOverlap;
    }

    function clearAllMarkerOverlays() {
        state.markerOverlays.forEach(ov => {
            if (state.engine === 'kakao' && typeof ov.setMap === 'function') {
                ov.setMap(null);
            } else if (state.map && typeof state.map.removeOverlay === 'function') {
                state.map.removeOverlay(ov);
            }
        });
        state.markerOverlays = [];
    }

    function addOverlayAtLonLat(lng, lat, element) {
        if (state.engine === 'kakao' && state.kakaoMap) {
            const ov = new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(lat, lng),
                content: element,
                xAnchor: 0.5,
                yAnchor: 0.5,
                clickable: true
            });
            ov.setMap(state.kakaoMap);
            state.markerOverlays.push(ov);
            return ov;
        }
        if (state.map) {
            const ov = new ol.Overlay({
                position: ol.proj.fromLonLat([lng, lat]),
                positioning: 'center-center',
                element,
                stopEvent: true
            });
            state.map.addOverlay(ov);
            state.markerOverlays.push(ov);
            return ov;
        }
        return null;
    }

    function getScreenPixelFromLonLat(lng, lat) {
        if (state.engine === 'kakao' && state.kakaoMap) {
            const proj = state.kakaoMap.getProjection();
            if (!proj) return null;
            const pt = proj.containerPointFromCoords(new kakao.maps.LatLng(lat, lng));
            return pt && !Number.isNaN(pt.x) ? [pt.x, pt.y] : null;
        }
        if (state.map) {
            const coord = ol.proj.fromLonLat([lng, lat]);
            return state.map.getPixelFromCoordinate(coord);
        }
        return null;
    }

    function renderMapMarkers() {
        if (!state.kakaoMap && !state.map) return;

        clearAllMarkerOverlays();

        if (state.filteredRestrooms.length === 0) return;

        const zoom = getMapZoom();

        // 각 화장실의 화면 픽셀 좌표 계산
        const points = state.filteredRestrooms.map(item => {
            const pixel = getScreenPixelFromLonLat(item.lng, item.lat);
            return {
                item,
                px: pixel ? pixel[0] : null,
                py: pixel ? pixel[1] : null
            };
        });

        // 아직 지도가 첫 렌더링 전이라 픽셀 좌표가 없으면 잠시 후 재실행
        if (points.some(p => p.px === null || p.py === null)) {
            if (state.engine === 'ol' && state.map) {
                state.map.once('postrender', () => renderMapMarkers());
            } else {
                setTimeout(() => renderMapMarkers(), 100);
            }
            return;
        }

        // 1. 줌 레벨이 낮을 때(zoom < 15.2) 근접 마커(72px 이내) 자동 클러스터링
        const singlePoints = [];
        const clusters = [];

        if (zoom < 15.2) {
            const visited = new Set();
            for (let i = 0; i < points.length; i++) {
                if (visited.has(i)) continue;
                const base = points[i];

                // 현재 선택된 마커는 클러스터에 묶지 않고 단독 표시
                if (base.item.id === state.selectedId) {
                    visited.add(i);
                    singlePoints.push(base);
                    continue;
                }

                const group = [base];
                visited.add(i);

                for (let j = i + 1; j < points.length; j++) {
                    if (visited.has(j)) continue;
                    const target = points[j];
                    if (target.item.id === state.selectedId) continue;

                    const distPx = Math.hypot(base.px - target.px, base.py - target.py);
                    if (distPx < 72) {
                        group.push(target);
                        visited.add(j);
                    }
                }

                if (group.length >= 2) {
                    clusters.push(group);
                } else {
                    singlePoints.push(base);
                }
            }
        } else {
            singlePoints.push(...points);
        }

        // 클러스터 마커 렌더링
        clusters.forEach(group => {
            const avgLng = group.reduce((sum, p) => sum + p.item.lng, 0) / group.length;
            const avgLat = group.reduce((sum, p) => sum + p.item.lat, 0) / group.length;
            const firstItem = group[0].item;

            const el = document.createElement('div');
            el.className = 'wc-cluster-pin';
            el.innerHTML = `
                <span>🚽 ${escapeHtml(firstItem.name)} 외 ${group.length - 1}곳</span>
                <span class="wc-cluster-count">${group.length}</span>
            `;

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                moveMapTo(avgLng, avgLat, Math.max(zoom + 2, 17));
            });

            addOverlayAtLonLat(avgLng, avgLat, el);
        });

        // 2. 개별 마커 생성 및 화면 픽셀 충돌 회피(Staggering) 배치
        const markerEntries = [];

        singlePoints.forEach(pt => {
            const { item, px, py } = pt;
            const el = document.createElement('div');
            const isSelected = state.selectedId === item.id;
            el.className = [
                'wc-map-pin',
                item.gender_separated ? 'separated' : '',
                !item.has_paper ? 'no-paper' : '',
                isSelected ? 'active' : ''
            ].filter(Boolean).join(' ');

            const shortPw = item.gender_separated
                ? `🔵${item.pw_male || '-'} 🔴${item.pw_female || '-'}`
                : `🔑${item.pw_common || '개방'}`;

            el.innerHTML = `
                <div class="wc-pin-dot"></div>
                <div class="wc-pin-stem"></div>
                <div class="wc-pin-bubble">
                    <span>🚽 ${escapeHtml(item.name)}</span>
                    <span class="wc-pin-pw">${escapeHtml(shortPw)}</span>
                </div>
            `;

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                selectRestroom(item.id, true);
            });

            addOverlayAtLonLat(item.lng, item.lat, el);

            markerEntries.push({
                item,
                el,
                bubbleEl: el.querySelector('.wc-pin-bubble'),
                stemEl: el.querySelector('.wc-pin-stem'),
                px,
                py,
                isSelected
            });
        });

        // 선택된 마커가 최우선으로 기본 슬롯(정중앙 상단)을 차지하도록 정렬
        markerEntries.sort((a, b) => (b.isSelected ? 1 : 0) - (a.isSelected ? 1 : 0));

        const placedBoxes = [];
        // 모든 앵커 도트 주변(반경 8px)도 침범하지 않도록 보호 영역 설정
        const dotBoxes = markerEntries.map(m => ({
            id: m.item.id,
            left: m.px - 8,
            right: m.px + 8,
            top: m.py - 8,
            bottom: m.py + 8
        }));

        markerEntries.forEach(entry => {
            const { item, bubbleEl, stemEl, px, py } = entry;
            const estWidth = (bubbleEl && bubbleEl.offsetWidth > 20)
                ? bubbleEl.offsetWidth
                : (item.name.length * 12 + 44);
            const estHeight = (bubbleEl && bubbleEl.offsetHeight > 14)
                ? bubbleEl.offsetHeight
                : 28;

            let bestSlot = LABEL_OFFSET_SLOTS[0];
            let minPenalty = Infinity;

            for (let s = 0; s < LABEL_OFFSET_SLOTS.length; s++) {
                const slot = LABEL_OFFSET_SLOTS[s];
                const cx = px + slot.dx;
                const cy = py + slot.dy;

                // 여유 마진 4px 포함 바운딩 박스
                const candidateBox = {
                    left: cx - estWidth / 2 - 4,
                    right: cx + estWidth / 2 + 4,
                    top: cy - estHeight / 2 - 3,
                    bottom: cy + estHeight / 2 + 3
                };

                let penalty = s * 12; // 기본 슬롯(가까운 위치) 선호 가중치

                // 이미 배치된 다른 라벨과의 겹침 면적 합산
                for (const placed of placedBoxes) {
                    const overlap = getOverlapArea(candidateBox, placed);
                    if (overlap > 0) {
                        penalty += 10000 + overlap * 10;
                    }
                }

                // 다른 마커의 실제 건물 위치 도트를 가리는지 확인
                for (const dot of dotBoxes) {
                    if (dot.id === item.id) continue;
                    const dotOverlap = getOverlapArea(candidateBox, dot);
                    if (dotOverlap > 0) {
                        penalty += 5000 + dotOverlap * 10;
                    }
                }

                if (penalty < minPenalty) {
                    minPenalty = penalty;
                    bestSlot = slot;
                    if (penalty < 100) break; // 겹침이 전혀 없는 첫 슬롯 즉시 확정
                }
            }

            placedBoxes.push({
                left: px + bestSlot.dx - estWidth / 2 - 4,
                right: px + bestSlot.dx + estWidth / 2 + 4,
                top: py + bestSlot.dy - estHeight / 2 - 3,
                bottom: py + bestSlot.dy + estHeight / 2 + 3
            });

            if (bubbleEl) {
                bubbleEl.style.setProperty('--dx', `${bestSlot.dx}px`);
                bubbleEl.style.setProperty('--dy', `${bestSlot.dy}px`);
            }

            if (stemEl) {
                const len = Math.hypot(bestSlot.dx, bestSlot.dy);
                const angleRad = Math.atan2(bestSlot.dy, bestSlot.dx);
                stemEl.style.width = `${Math.max(0, len - 6)}px`;
                stemEl.style.transform = `rotate(${angleRad}rad)`;
            }
        });
    }

    function selectRestroom(id, animateMap = true) {
        const item = state.filteredRestrooms.find(r => r.id === id) || state.restrooms.find(r => r.id === id);
        if (!item) return;

        state.selectedId = id;
        renderRestroomList();
        renderMapMarkers();
        openDetailSheet(item);

        // 리스트 내 스크롤 이동
        const cardEl = document.querySelector(`.restroom-card[data-id="${CSS.escape(id)}"]`);
        if (cardEl) {
            cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // 모바일: 지도와 상세 카드가 보이도록 바텀시트를 접음
        if (isMobileLayout() && state.sheetState !== 'collapsed') {
            setSheetState('collapsed');
        }

        if (animateMap) {
            moveMapTo(item.lng, item.lat, Math.max(getMapZoom(), 17));
        }
    }

    function closeDetailSheet() {
        const sheet = document.getElementById('detail-sheet');
        if (sheet) sheet.style.display = 'none';
        document.getElementById('app-shell').classList.remove('detail-open');
    }

    function openDetailSheet(item) {
        const sheet = document.getElementById('detail-sheet');
        if (!sheet) return;

        const currentUser = window.WCDB.currentUser;
        const canManage = currentUser && (currentUser.role === 'admin' || currentUser.username === item.created_by);

        const naverUrl = `https://map.naver.com/p/search/${encodeURIComponent(item.name)}`;
        const kakaoUrl = `https://map.kakao.com/link/to/${encodeURIComponent(item.name)},${item.lat},${item.lng}`;
        const googleUrl = `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}`;

        sheet.style.display = 'block';
        document.getElementById('app-shell').classList.add('detail-open');
        sheet.innerHTML = `
            <div class="detail-header">
                <div>
                    <div class="detail-title">${escapeHtml(item.name)}</div>
                    <div class="detail-sub">
                        ${escapeHtml(item.location_detail || '')} · ${escapeHtml(item.floor || '1층')}
                        ${item.region ? ` (${escapeHtml(item.region)})` : ''}
                    </div>
                </div>
                <button type="button" class="close-sheet-btn" id="btn-close-detail">×</button>
            </div>

            <div class="detail-pw-box">
                <div class="detail-pw-label">
                    <span>🔐 화장실 비밀번호 (배지 클릭 시 즉시 복사)</span>
                    ${item.distance !== null && item.distance !== undefined ? `<span>🚶 ${formatDistance(item.distance)} (${formatWalkingTime(item.distance)})</span>` : ''}
                </div>
                <div class="pw-badge-row" style="margin-top:4px;">
                    ${renderPwBadgesHtml(item)}
                </div>
            </div>

            <div class="card-meta-tags" style="margin-bottom:10px;">
                <span class="meta-tag">${item.gender_separated ? '🚻 남녀분리 화장실' : '🚪 남녀공용 화장실'}</span>
                <span class="meta-tag ${item.has_paper ? '' : 'warn'}">${item.has_paper ? '🧻 휴지 구비됨' : '⚠️ 휴지 개인지참 필수!'}</span>
                ${item.note ? `<span class="meta-tag">💡 ${escapeHtml(item.note)}</span>` : ''}
            </div>

            <div class="detail-actions">
                <a class="nav-btn" href="${kakaoUrl}" target="_blank" rel="noopener">🟡 카카오맵 길찾기</a>
                <a class="nav-btn" href="${naverUrl}" target="_blank" rel="noopener">🟢 네이버 길찾기</a>
                <a class="nav-btn" href="${googleUrl}" target="_blank" rel="noopener">🔵 구글맵 길찾기</a>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:nowrap; gap:8px; margin-top:12px; padding-top:10px; border-top:1px solid var(--border-color);">
                <button type="button" class="text-link-btn" id="btn-share-wc">📤 위치/비번 복사</button>
                <div style="display:flex; gap:8px; flex-shrink:0;">
                    <button type="button" class="text-link-btn" id="btn-edit-wc">✏️ 정보 수정</button>
                    ${canManage ? `<button type="button" class="text-link-btn" id="btn-delete-wc" style="color:var(--danger);">🗑️ 삭제</button>` : ''}
                </div>
            </div>
        `;

        sheet.querySelector('#btn-close-detail').onclick = () => {
            closeDetailSheet();
            state.selectedId = null;
            renderRestroomList();
            renderMapMarkers();
        };

        sheet.querySelectorAll('[data-copy-pw]').forEach(btn => {
            btn.onclick = () => {
                const pw = btn.getAttribute('data-copy-pw');
                copyText(pw, `비밀번호 [${pw}] 복사 완료!`);
            };
        });

        sheet.querySelector('#btn-share-wc').onclick = () => {
            const pwText = item.gender_separated
                ? `남자: ${item.pw_male || '-'} / 여자: ${item.pw_female || '-'}`
                : `비밀번호: ${item.pw_common || '없음'}`;
            const shareMsg = `[대똥여지도 화장실 공유]\n📍 장소: ${item.name} (${item.location_detail} ${item.floor})\n🔑 ${pwText}\n🧻 휴지: ${item.has_paper ? '구비됨' : '개인지참 필수'}\n🗺️ 길찾기: ${kakaoUrl}`;
            copyText(shareMsg, '화장실 정보와 길찾기 링크가 복사되었습니다!');
        };

        sheet.querySelector('#btn-edit-wc').onclick = () => openRestroomModal(item);

        const delBtn = sheet.querySelector('#btn-delete-wc');
        if (delBtn) {
            delBtn.onclick = async () => {
                if (!confirm(`[${item.name}] 화장실 정보를 삭제하시겠습니까?`)) return;
                try {
                    await window.WCDB.deleteRestroom(item.id);
                    closeDetailSheet();
                    state.selectedId = null;
                    showToast('삭제되었습니다.');
                    await loadRestrooms();
                } catch (err) {
                    showToast('삭제 실패: ' + err.message);
                }
            };
        }
    }

    // ========================================================================
    // 내 위치 기반 '가장 가까운 화장실 찾기' (급똥 응급 모드)
    // ========================================================================
    function findNearestRestroom() {
        if (!navigator.geolocation) {
            fallbackToMapCenterNearest('이 브라우저는 GPS를 지원하지 않아 현재 지도 중심 기준으로 가장 가까운 화장실을 찾습니다.');
            return;
        }

        showToast('📡 내 현재 GPS 위치를 확인하는 중...');
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                const userCoords = [pos.coords.longitude, pos.coords.latitude];
                state.userLocation = userCoords;
                placeUserGpsMarker(userCoords);

                state.activeFilter = 'nearest';
                updateFilterChipsUI();
                recalculateDistancesAndFilter();

                if (state.filteredRestrooms.length > 0) {
                    const nearest = state.filteredRestrooms[0];
                    selectRestroom(nearest.id, true);
                    showToast(`🚨 가장 가까운 [${nearest.name}] (${formatDistance(nearest.distance)}) 발견!`);
                }
            },
            function () {
                fallbackToMapCenterNearest('GPS 위치 권한이 꺼져 있어 현재 보고 계신 지도 중심 기준으로 가장 가까운 화장실을 찾았습니다.');
            },
            { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 }
        );
    }

    // 지도 우측 '내 위치' 버튼: GPS 위치로 지도 이동 + 내 위치 마커 표시
    function goToMyLocation() {
        if (!navigator.geolocation) {
            showToast('이 브라우저는 GPS를 지원하지 않습니다.');
            return;
        }
        const btn = document.getElementById('btn-my-location');
        if (btn) btn.classList.add('locating');
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                if (btn) btn.classList.remove('locating');
                const userCoords = [pos.coords.longitude, pos.coords.latitude];
                state.userLocation = userCoords;
                placeUserGpsMarker(userCoords);
                moveMapTo(userCoords[0], userCoords[1], 17);
                recalculateDistancesAndFilter();
            },
            function () {
                if (btn) btn.classList.remove('locating');
                showToast('위치 권한을 허용해주세요.');
            },
            { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 }
        );
    }

    function fallbackToMapCenterNearest(noticeMsg) {
        const centerLonLat = getMapCenterLonLat();
        state.userLocation = [centerLonLat[0], centerLonLat[1]];
        placeUserGpsMarker(state.userLocation);

        state.activeFilter = 'nearest';
        updateFilterChipsUI();
        recalculateDistancesAndFilter();

        if (state.filteredRestrooms.length > 0) {
            selectRestroom(state.filteredRestrooms[0].id, true);
        }
        showToast(noticeMsg);
    }

    function placeUserGpsMarker(coords) {
        if (state.userMarkerOverlay) {
            if (state.engine === 'kakao' && typeof state.userMarkerOverlay.setMap === 'function') {
                state.userMarkerOverlay.setMap(null);
            } else if (state.map && typeof state.map.removeOverlay === 'function') {
                state.map.removeOverlay(state.userMarkerOverlay);
            }
            state.userMarkerOverlay = null;
        }
        const el = document.createElement('div');
        el.className = 'user-gps-marker';
        el.title = '내 위치';

        if (state.engine === 'kakao' && state.kakaoMap) {
            state.userMarkerOverlay = new kakao.maps.CustomOverlay({
                position: new kakao.maps.LatLng(coords[1], coords[0]),
                content: el,
                xAnchor: 0.5,
                yAnchor: 0.5
            });
            state.userMarkerOverlay.setMap(state.kakaoMap);
            return;
        }

        if (state.map) {
            state.userMarkerOverlay = new ol.Overlay({
                position: ol.proj.fromLonLat(coords),
                positioning: 'center-center',
                element: el,
                stopEvent: false
            });
            state.map.addOverlay(state.userMarkerOverlay);
        }
    }

    // ========================================================================
    // 화장실 추가 / 제보 / 수정 모달 & 지도 위치 피커
    // ========================================================================
    // ========================================================================
    // 위경도 좌표 -> 한국 지역/동네명 역지오코딩 자동 입력 (2중 폴백)
    // ========================================================================
    async function autoFillRegionFromCoords(lat, lng) {
        const regionInput = document.getElementById('wc-region');
        if (!regionInput || Number.isNaN(lat) || Number.isNaN(lng)) return;

        const prevPlaceholder = regionInput.placeholder;
        regionInput.placeholder = '📍 주소/동네명 자동 확인 중...';

        function dedupeParts(parts) {
            const seen = new Set();
            const result = [];
            parts.forEach(p => {
                const clean = (p || '').trim();
                if (clean && !seen.has(clean)) {
                    seen.add(clean);
                    result.push(clean);
                }
            });
            return result.join(' ');
        }

        // 0차 최우선 시도: 카카오맵 Geocoder (카카오맵 연동 시 가장 정확한 대한민국 행정동/법정동 반환)
        if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
            try {
                const geocoder = new window.kakao.maps.services.Geocoder();
                const kakaoRegion = await new Promise((resolve) => {
                    geocoder.coord2RegionCode(lng, lat, (result, status) => {
                        if (status === window.kakao.maps.services.Status.OK && result && result.length > 0) {
                            const bRegion = result.find(r => r.region_type === 'B') || result[0];
                            resolve(bRegion.address_name || '');
                        } else {
                            resolve('');
                        }
                    });
                });
                if (kakaoRegion) {
                    regionInput.value = kakaoRegion;
                    regionInput.placeholder = prevPlaceholder;
                    return kakaoRegion;
                }
            } catch (e) {
                // 무시 후 다음 단계 진행
            }
        }

        // 1차 시도: OpenStreetMap Nominatim (상세 법정동/행정동 추출)
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1&accept-language=ko`
            );
            if (res.ok) {
                const data = await res.json();
                const addr = data.address || {};
                const p1 = addr.province || addr.state || '';
                const p2 = addr.city || addr.county || '';
                const p3 = addr.borough || addr.district || addr.suburb || addr.town || '';
                const p4 = addr.quarter || addr.neighbourhood || addr.village || addr.hamlet || '';
                const regionText = dedupeParts([p1, p2, p3, p4]);
                if (regionText) {
                    regionInput.value = regionText;
                    regionInput.placeholder = prevPlaceholder;
                    return regionText;
                }
            }
        } catch (e) {
            // 로컬 file:// 환경 등에서 차단 시 2차 폴백 진행
        }

        // 2차 폴백: BigDataCloud 한국어 역지오코딩 (API 키 및 Referer 제한 없음)
        try {
            const res2 = await fetch(
                `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=ko`
            );
            if (res2.ok) {
                const data2 = await res2.json();
                const p1 = data2.principalSubdivision || '';
                const p2 = data2.city || '';
                const p3 = data2.locality || '';
                const regionText2 = dedupeParts([p1, p2, p3]);
                if (regionText2) {
                    regionInput.value = regionText2;
                    regionInput.placeholder = prevPlaceholder;
                    return regionText2;
                }
            }
        } catch (e) {
            // 무시
        }

        regionInput.placeholder = prevPlaceholder;
        return '';
    }

    function openRestroomModal(item = null) {
        state.editingRestroomId = item ? item.id : null;
        document.getElementById('wc-modal-title').textContent = item ? '✏️ 화장실 정보 수정' : '➕ 새 화장실 추가 / 제보';

        const centerCoords = getMapCenterLonLat();

        const initLat = item ? item.lat : Number(centerCoords[1].toFixed(7));
        const initLng = item ? item.lng : Number(centerCoords[0].toFixed(7));

        document.getElementById('wc-name').value = item ? item.name : '';
        document.getElementById('wc-detail').value = item ? item.location_detail : '';

        const floorSelect = document.getElementById('wc-floor');
        const floorVal = item && item.floor ? item.floor : '1층';
        // 기존 데이터에 없는 층수인 경우 동적으로 옵션 추가 후 선택
        if (floorSelect && ![...floorSelect.options].some(o => o.value === floorVal)) {
            const opt = document.createElement('option');
            opt.value = floorVal;
            opt.textContent = floorVal;
            floorSelect.appendChild(opt);
        }
        if (floorSelect) floorSelect.value = floorVal;

        document.getElementById('wc-region').value = item ? (item.region || '') : '';
        document.getElementById('wc-lat').value = initLat;
        document.getElementById('wc-lng').value = initLng;
        document.getElementById('wc-separated').checked = item ? Boolean(item.gender_separated) : false;
        document.getElementById('wc-paper').checked = item ? Boolean(item.has_paper) : true;
        document.getElementById('wc-pw-common').value = item ? (item.pw_common || '') : '';
        document.getElementById('wc-pw-male').value = item ? (item.pw_male || '') : '';
        document.getElementById('wc-pw-female').value = item ? (item.pw_female || '') : '';
        document.getElementById('wc-note').value = item ? (item.note || '') : '';

        syncPasswordFieldsVisibility();
        document.getElementById('wc-modal').classList.add('open');

        // 신규 등록이거나 지역명이 비어있으면 현재 좌표 기준 지역/동네명 자동 입력
        if (!item || !item.region) {
            autoFillRegionFromCoords(initLat, initLng);
        }
    }

    function syncPasswordFieldsVisibility() {
        const isSeparated = document.getElementById('wc-separated').checked;
        document.getElementById('pw-common-group').style.display = isSeparated ? 'none' : 'block';
        document.getElementById('pw-separated-group').style.display = isSeparated ? 'grid' : 'none';
    }

    // ========================================================================
    // 지도 위치 찍기 모드 (중앙 고정 핀 + 장소/주소/좌표 검색)
    // ========================================================================
    function isValidLatLng(lat, lng) {
        return Number.isFinite(lat) && Number.isFinite(lng) &&
            Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }

    // "37.5205, 126.7428" / "126.7428 37.5205" 같은 좌표 문자열 파싱 (순서가 뒤바뀌어도 한국 범위 기준으로 보정)
    function parseCoordText(text) {
        const m = String(text || '').match(/(-?\d{1,3}(?:\.\d+)?)\s*[,\s/]\s*(-?\d{1,3}(?:\.\d+)?)/);
        if (!m) return null;
        let a = parseFloat(m[1]);
        let b = parseFloat(m[2]);
        if (Math.abs(a) > 90) {
            [a, b] = [b, a];
        }
        if (!isValidLatLng(a, b)) return null;
        return { lat: Number(a.toFixed(7)), lng: Number(b.toFixed(7)) };
    }

    function updatePickCoordReadout() {
        if (!state.isPickingLocation) return;
        const el = document.getElementById('pick-coord-readout');
        if (!el) return;
        const c = getMapCenterLonLat();
        el.textContent = `📍 위도 ${c[1].toFixed(6)} · 경도 ${c[0].toFixed(6)}`;
    }

    function startLocationPicking() {
        state.isPickingLocation = true;
        state.pickPlaceName = '';
        document.getElementById('wc-modal').classList.remove('open');
        document.body.classList.add('picking');
        document.getElementById('pick-search-input').value = '';
        document.getElementById('pick-search-results').innerHTML = '';
        refreshMapSize();

        // 이미 입력된 좌표가 있으면 그 위치에서 시작
        const lat = parseFloat(document.getElementById('wc-lat').value);
        const lng = parseFloat(document.getElementById('wc-lng').value);
        if (isValidLatLng(lat, lng)) {
            moveMapTo(lng, lat, Math.max(getMapZoom(), 17));
        }
        setTimeout(updatePickCoordReadout, 80);
    }

    function stopLocationPicking() {
        state.isPickingLocation = false;
        document.body.classList.remove('picking');
        document.getElementById('pick-search-results').innerHTML = '';
        refreshMapSize();
    }

    function confirmLocationPicking() {
        const c = getMapCenterLonLat();
        finishLocationPicking(Number(c[0].toFixed(7)), Number(c[1].toFixed(7)));
    }

    async function finishLocationPicking(lng, lat) {
        stopLocationPicking();

        document.getElementById('wc-lng').value = lng;
        document.getElementById('wc-lat').value = lat;
        const nameInput = document.getElementById('wc-name');
        if (state.pickPlaceName && !nameInput.value.trim()) {
            nameInput.value = state.pickPlaceName;
        }
        document.getElementById('wc-modal').classList.add('open');

        const regionText = await autoFillRegionFromCoords(lat, lng);
        showToast(regionText ? `✅ [${regionText}] 위치가 자동 입력되었습니다.` : '✅ 선택한 지도 좌표가 입력되었습니다.');
    }

    // 장소·주소 검색: 카카오 로컬(Places/주소) 우선, 실패 시 OpenStreetMap Nominatim 폴백
    async function searchPlacesForPick(query) {
        const services = window.kakao && window.kakao.maps && window.kakao.maps.services;
        if (services) {
            const center = getMapCenterLonLat();
            const kakaoPlaces = await new Promise((resolve) => {
                try {
                    new services.Places().keywordSearch(query, (data, status) => {
                        resolve(status === services.Status.OK ? data : []);
                    }, { location: new kakao.maps.LatLng(center[1], center[0]), size: 10 });
                } catch (e) {
                    resolve([]);
                }
            });
            if (kakaoPlaces.length > 0) {
                return kakaoPlaces.map(p => ({
                    name: p.place_name,
                    addr: p.road_address_name || p.address_name || '',
                    lat: parseFloat(p.y),
                    lng: parseFloat(p.x)
                }));
            }
            const kakaoAddrs = await new Promise((resolve) => {
                try {
                    new services.Geocoder().addressSearch(query, (data, status) => {
                        resolve(status === services.Status.OK ? data : []);
                    });
                } catch (e) {
                    resolve([]);
                }
            });
            if (kakaoAddrs.length > 0) {
                return kakaoAddrs.map(a => ({
                    name: a.address_name,
                    addr: (a.road_address && a.road_address.building_name) || '',
                    lat: parseFloat(a.y),
                    lng: parseFloat(a.x),
                    isAddress: true
                }));
            }
        }

        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=kr&limit=10&accept-language=ko`
            );
            if (res.ok) {
                const data = await res.json();
                return data.map(d => ({
                    name: d.name || String(d.display_name || '').split(',')[0],
                    addr: d.display_name || '',
                    lat: parseFloat(d.lat),
                    lng: parseFloat(d.lon)
                }));
            }
        } catch (e) {
            // 네트워크 차단 시 빈 결과
        }
        return [];
    }

    async function handlePickSearch(e) {
        e.preventDefault();
        const input = document.getElementById('pick-search-input');
        const resultsEl = document.getElementById('pick-search-results');
        const query = input.value.trim();
        if (!query) return;
        input.blur();

        const coord = parseCoordText(query);
        if (coord) {
            resultsEl.innerHTML = '';
            state.pickPlaceName = '';
            moveMapTo(coord.lng, coord.lat, 18);
            showToast('📍 입력한 좌표로 이동했습니다.');
            return;
        }

        resultsEl.innerHTML = '<div class="pick-result-empty">🔍 검색 중...</div>';
        const results = (await searchPlacesForPick(query)).filter(r => isValidLatLng(r.lat, r.lng));
        if (results.length === 0) {
            resultsEl.innerHTML = '<div class="pick-result-empty">검색 결과가 없습니다. 지도를 직접 움직여 핀을 맞추거나 좌표를 입력해보세요.</div>';
            return;
        }

        resultsEl.innerHTML = results.map((r, i) => `
            <button type="button" class="pick-result-item" data-idx="${i}">
                <div class="pick-result-name">${escapeHtml(r.name)}</div>
                ${r.addr ? `<div class="pick-result-addr">${escapeHtml(r.addr)}</div>` : ''}
            </button>
        `).join('');
        resultsEl.querySelectorAll('.pick-result-item').forEach(btn => {
            btn.onclick = () => {
                const r = results[Number(btn.getAttribute('data-idx'))];
                state.pickPlaceName = r.isAddress ? '' : r.name;
                resultsEl.innerHTML = '';
                moveMapTo(r.lng, r.lat, 18);
                showToast('핀 위치를 확인하고 필요하면 지도를 살짝 움직여 맞춘 뒤 [이 위치로 선택]을 누르세요.');
            };
        });
    }

    async function handleSaveRestroomForm(e) {
        e.preventDefault();
        const name = document.getElementById('wc-name').value.trim();
        if (!name) {
            showToast('건물/장소명을 입력해주세요.');
            return;
        }

        const latVal = parseFloat(document.getElementById('wc-lat').value);
        const lngVal = parseFloat(document.getElementById('wc-lng').value);
        if (!isValidLatLng(latVal, lngVal)) {
            showToast('위도/경도 좌표가 올바르지 않습니다. 🎯 지도에서 찍기 또는 📡 내 현재 위치로 위치를 지정해주세요.');
            return;
        }

        const isSeparated = document.getElementById('wc-separated').checked;
        const payload = {
            id: state.editingRestroomId,
            name,
            location_detail: document.getElementById('wc-detail').value.trim(),
            floor: document.getElementById('wc-floor').value.trim() || '1층',
            region: document.getElementById('wc-region').value.trim(),
            lat: latVal,
            lng: lngVal,
            gender_separated: isSeparated,
            has_paper: document.getElementById('wc-paper').checked,
            pw_common: isSeparated ? '' : document.getElementById('wc-pw-common').value.trim(),
            pw_male: isSeparated ? document.getElementById('wc-pw-male').value.trim() : '',
            pw_female: isSeparated ? document.getElementById('wc-pw-female').value.trim() : '',
            note: document.getElementById('wc-note').value.trim()
        };

        try {
            const saved = await window.WCDB.saveRestroom(payload);
            document.getElementById('wc-modal').classList.remove('open');
            showToast(state.editingRestroomId ? '✅ 화장실 정보가 수정되었습니다.' : '🎉 새 화장실이 등록되었습니다!');
            await loadRestrooms();
            if (saved && saved.id) {
                selectRestroom(saved.id, true);
            }
        } catch (err) {
            showToast('저장 실패: ' + err.message);
        }
    }

    // ========================================================================
    // 관리자 센터 모달 (사용자 계정 부여/관리 + 화장실 관리 + 클라우드 DB 설정)
    // ========================================================================
    async function openAdminModal(defaultTab = 'users') {
        document.getElementById('admin-modal').classList.add('open');
        switchAdminTab(defaultTab);
    }

    async function switchAdminTab(tabName) {
        document.querySelectorAll('.admin-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-admin-tab') === tabName);
        });

        document.getElementById('admin-tab-users').style.display = tabName === 'users' ? 'block' : 'none';
        document.getElementById('admin-tab-restrooms').style.display = tabName === 'restrooms' ? 'block' : 'none';
        const logsTab = document.getElementById('admin-tab-logs');
        if (logsTab) logsTab.style.display = tabName === 'logs' ? 'block' : 'none';
        document.getElementById('admin-tab-cloud').style.display = tabName === 'cloud' ? 'block' : 'none';

        if (tabName === 'users') {
            await renderAdminUsersList();
        } else if (tabName === 'restrooms') {
            renderAdminRestroomsTable();
        } else if (tabName === 'logs') {
            await renderAdminLogsTable();
        } else if (tabName === 'cloud') {
            renderAdminCloudSettings();
        }
    }

    async function renderAdminUsersList() {
        const tbody = document.getElementById('admin-users-tbody');
        if (!tbody) return;
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">불러오는 중...</td></tr>`;

        try {
            const users = await window.WCDB.adminListUsers();
            state.adminUsersCache = users;

            tbody.innerHTML = users.map(u => {
                const knownPw = state.lastCreatedCredentials[u.username] || (u.username === 'user01' ? '1234' : '');
                return `
                    <tr>
                        <td><b>${escapeHtml(u.username)}</b></td>
                        <td>${escapeHtml(u.display_name)}</td>
                        <td>
                            <span class="role-badge ${u.role === 'admin' ? 'admin' : ''}">
                                ${u.role === 'admin' ? '관리자' : '일반회원'}
                            </span>
                        </td>
                        <td>
                            <span style="font-weight:700; color:${u.is_active ? 'var(--success)' : 'var(--danger)'};">
                                ${u.is_active ? '● 활성' : '⛔ 정지됨'}
                            </span>
                        </td>
                        <td style="color:var(--text-secondary); font-size:12px;">${escapeHtml(u.memo || '-')}</td>
                        <td>
                            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                <button type="button" class="icon-btn" data-invite-user="${escapeHtml(u.username)}" data-invite-name="${escapeHtml(u.display_name)}" data-invite-pw="${escapeHtml(knownPw)}">
                                    📋 계정안내 복사
                                </button>
                                <button type="button" class="icon-btn" data-reset-pw-id="${escapeHtml(u.id)}" data-reset-username="${escapeHtml(u.username)}">
                                    🔑 비번변경
                                </button>
                                <button type="button" class="icon-btn" data-toggle-active-id="${escapeHtml(u.id)}" data-current-active="${u.is_active}">
                                    ${u.is_active ? '정지' : '활성화'}
                                </button>
                                ${u.username !== 'admin' ? `<button type="button" class="icon-btn" style="color:var(--danger);" data-del-user-id="${escapeHtml(u.id)}">삭제</button>` : ''}
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');

            // 이벤트 바인딩: 카톡 초대장 복사
            tbody.querySelectorAll('[data-invite-user]').forEach(btn => {
                btn.onclick = () => {
                    const uname = btn.getAttribute('data-invite-user');
                    const dname = btn.getAttribute('data-invite-name');
                    const pw = btn.getAttribute('data-invite-pw') || '(설정한 비밀번호)';
                    const msg = `[대똥여지도 전용 계정 안내]\n안녕하세요 ${dname}님! 프라이빗 화장실 지도 계정이 발급되었습니다.\n\n• 접속 주소: ${window.location.origin}${window.location.pathname}\n• 아이디: ${uname}\n• 비밀번호: ${pw}\n\n접속 후 상단 '비번변경'에서 비밀번호를 변경하실 수 있습니다.`;
                    copyText(msg, `[${uname}] 계정 안내 문구가 복사되었습니다! 카톡 등에 붙여넣으세요.`);
                };
            });

            // 이벤트 바인딩: 비밀번호 재설정
            tbody.querySelectorAll('[data-reset-pw-id]').forEach(btn => {
                btn.onclick = async () => {
                    const uid = btn.getAttribute('data-reset-pw-id');
                    const uname = btn.getAttribute('data-reset-username');
                    const newPw = prompt(`[${uname}] 계정의 새 비밀번호를 입력하세요 (4자 이상):`);
                    if (!newPw) return;
                    if (newPw.length < 4) {
                        showToast('비밀번호는 4자 이상이어야 합니다.');
                        return;
                    }
                    try {
                        await window.WCDB.adminSaveUser({ id: uid, password: newPw });
                        state.lastCreatedCredentials[uname] = newPw;
                        showToast(`✅ [${uname}] 비밀번호가 변경되었습니다.`);
                        await renderAdminUsersList();
                    } catch (err) {
                        showToast('변경 실패: ' + err.message);
                    }
                };
            });

            // 이벤트 바인딩: 활성/정지 토글
            tbody.querySelectorAll('[data-toggle-active-id]').forEach(btn => {
                btn.onclick = async () => {
                    const uid = btn.getAttribute('data-toggle-active-id');
                    const cur = btn.getAttribute('data-current-active') === 'true';
                    try {
                        await window.WCDB.adminSaveUser({ id: uid, is_active: !cur });
                        showToast(!cur ? '계정이 활성화되었습니다.' : '계정이 일시정지되었습니다.');
                        await renderAdminUsersList();
                    } catch (err) {
                        showToast('처리 실패: ' + err.message);
                    }
                };
            });

            // 이벤트 바인딩: 계정 삭제
            tbody.querySelectorAll('[data-del-user-id]').forEach(btn => {
                btn.onclick = async () => {
                    const uid = btn.getAttribute('data-del-user-id');
                    if (!confirm('해당 사용자 계정을 영구 삭제하시겠습니까?')) return;
                    try {
                        await window.WCDB.adminDeleteUser(uid);
                        showToast('계정이 삭제되었습니다.');
                        await renderAdminUsersList();
                    } catch (err) {
                        showToast('삭제 실패: ' + err.message);
                    }
                };
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger);">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    function renderAdminRestroomsTable() {
        const tbody = document.getElementById('admin-restrooms-tbody');
        if (!tbody) return;

        const searchEl = document.getElementById('admin-wc-search');
        const q = (searchEl ? searchEl.value : '').trim().toLowerCase();

        const rows = state.restrooms.filter(r => {
            if (!q) return true;
            return `${r.name} ${r.location_detail} ${r.region} ${r.floor} ${r.pw_common} ${r.pw_male} ${r.pw_female}`.toLowerCase().includes(q);
        });

        if (rows.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">검색 조건에 맞는 화장실 데이터가 없습니다.</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(r => {
            const pwHtml = r.gender_separated
                ? `<span style="color:var(--male-color);font-weight:800;">🔵${escapeHtml(r.pw_male || '-')}</span> · <span style="color:var(--female-color);font-weight:800;">🔴${escapeHtml(r.pw_female || '-')}</span>`
                : `<span style="font-weight:800;">🔑 ${escapeHtml(r.pw_common || '개방')}</span>`;
            const detailText = `${r.location_detail || '-'} (${r.floor || '1층'})`;
            return `
                <tr>
                    <td title="${escapeHtml(r.name)}"><b>${escapeHtml(r.name)}</b></td>
                    <td title="${escapeHtml(detailText)}">${escapeHtml(detailText)}</td>
                    <td title="${escapeHtml(r.gender_separated ? `남:${r.pw_male} / 여:${r.pw_female}` : r.pw_common)}">${pwHtml}</td>
                    <td>
                        <span class="meta-tag ${r.has_paper ? '' : 'warn'}">
                            ${r.has_paper ? '🧻 구비' : '⚠️ 미구비'}
                        </span>
                    </td>
                    <td>${escapeHtml(r.created_by || 'admin')}</td>
                    <td>
                        <div style="display:flex; gap:6px;">
                            <button type="button" class="icon-btn" style="height:30px; padding:0 9px;" data-admin-edit-wc="${escapeHtml(r.id)}">수정</button>
                            <button type="button" class="icon-btn" style="height:30px; padding:0 9px; color:var(--danger);" data-admin-del-wc="${escapeHtml(r.id)}">삭제</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-admin-edit-wc]').forEach(btn => {
            btn.onclick = () => {
                const id = btn.getAttribute('data-admin-edit-wc');
                const item = state.restrooms.find(x => x.id === id);
                if (item) {
                    document.getElementById('admin-modal').classList.remove('open');
                    openRestroomModal(item);
                }
            };
        });

        tbody.querySelectorAll('[data-admin-del-wc]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.getAttribute('data-admin-del-wc');
                if (!confirm('정말 이 화장실을 삭제하시겠습니까?')) return;
                try {
                    await window.WCDB.deleteRestroom(id);
                    showToast('삭제되었습니다.');
                    await loadRestrooms();
                    renderAdminRestroomsTable();
                } catch (err) {
                    showToast('삭제 실패: ' + err.message);
                }
            };
        });
    }

    function formatKoreanDateTime(isoStr) {
        if (!isoStr) return '-';
        const d = new Date(isoStr);
        if (Number.isNaN(d.getTime())) return isoStr;
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function getLogBadgeHtml(actionType) {
        const map = {
            LOGIN_SUCCESS: { cls: 'login', text: '🔑 로그인 성공' },
            LOGIN_FAIL: { cls: 'delete', text: '⛔ 로그인 실패' },
            LOGIN_BLOCKED: { cls: 'delete', text: '🚫 정지계정 차단' },
            LOGOUT: { cls: 'login', text: '🚪 로그아웃' },
            PASSWORD_CHANGE: { cls: 'update', text: '🔐 비번 변경' },
            RESTROOM_CREATE: { cls: 'create', text: '➕ 화장실 등록' },
            RESTROOM_UPDATE: { cls: 'update', text: '✏️ 화장실 수정' },
            RESTROOM_DELETE: { cls: 'delete', text: '🗑️ 화장실 삭제' },
            USER_CREATE: { cls: 'create', text: '👤 계정 발급' },
            USER_UPDATE: { cls: 'update', text: '⚙️ 계정 변경' },
            USER_DELETE: { cls: 'delete', text: '🗑️ 계정 삭제' }
        };
        const item = map[actionType] || { cls: 'login', text: actionType };
        return `<span class="log-badge ${item.cls}">${escapeHtml(item.text)}</span>`;
    }

    async function renderAdminLogsTable() {
        const tbody = document.getElementById('admin-logs-tbody');
        if (!tbody) return;
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:20px;">로그 데이터를 불러오는 중...</td></tr>`;

        try {
            const logs = await window.WCDB.adminGetLogs(250);
            const filterEl = document.getElementById('admin-log-filter');
            const filterVal = filterEl ? filterEl.value : 'all';

            const filtered = logs.filter(log => {
                if (filterVal === 'all') return true;
                return (log.action_type || '').startsWith(filterVal);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--text-muted);">기록된 로그가 없습니다.</td></tr>`;
                return;
            }

            tbody.innerHTML = filtered.map((log, idx) => {
                const actorText = log.actor_display_name
                    ? `${log.actor_username} (${log.actor_display_name})`
                    : log.actor_username;

                // device_info ("IP: xxx | 위치: xxx | 기기: xxx") 파싱
                const rawDev = log.device_info || '';
                let ipLocText = '-';
                let devEnvText = rawDev || '-';

                if (rawDev.includes('|')) {
                    const parts = rawDev.split('|').map(s => s.trim());
                    const ipPart = (parts.find(p => p.startsWith('IP:')) || '').replace(/^IP:\s*/, '');
                    const locPart = (parts.find(p => p.startsWith('위치:')) || '').replace(/^위치:\s*/, '');
                    const devPart = (parts.find(p => p.startsWith('기기:')) || '').replace(/^기기:\s*/, '');
                    ipLocText = [ipPart ? `🌐 ${ipPart}` : '', locPart ? `📍 ${locPart}` : ''].filter(Boolean).join(' · ') || '-';
                    devEnvText = devPart || '-';
                } else if (rawDev.startsWith('IP:')) {
                    ipLocText = `🌐 ${rawDev.replace(/^IP:\s*/, '')}`;
                    devEnvText = '-';
                }

                const summaryDetail = [log.target_name, log.detail].filter(Boolean).join(' - ') || '-';

                return `
                    <tr data-log-idx="${idx}" style="cursor:pointer;" title="클릭하면 전체 접속 IP·위치·단말기 상세 정보를 봅니다">
                        <td style="font-size:12px; color:var(--text-secondary);">${escapeHtml(formatKoreanDateTime(log.created_at))}</td>
                        <td>${getLogBadgeHtml(log.action_type)}</td>
                        <td title="${escapeHtml(actorText)}"><b>${escapeHtml(actorText)}</b></td>
                        <td style="font-weight:700; color:var(--accent);" title="${escapeHtml(ipLocText)}">${escapeHtml(ipLocText)}</td>
                        <td style="font-size:12px; color:var(--text-secondary);" title="${escapeHtml(devEnvText)}">${escapeHtml(devEnvText)}</td>
                        <td title="${escapeHtml(summaryDetail)}">${escapeHtml(summaryDetail)}</td>
                    </tr>
                `;
            }).join('');

            tbody.querySelectorAll('tr[data-log-idx]').forEach(row => {
                row.onclick = () => {
                    const log = filtered[Number(row.getAttribute('data-log-idx'))];
                    if (!log) return;
                    alert(
                        `[접속 · 활동 상세 로그]\n\n` +
                        `• 일시: ${formatKoreanDateTime(log.created_at)}\n` +
                        `• 구분: ${log.action_type}\n` +
                        `• 계정: ${log.actor_username} (${log.actor_display_name || '-'})\n` +
                        `• 대상: ${log.target_name || '-'}\n` +
                        `• 내역: ${log.detail || '-'}\n` +
                        `• 접속환경(IP/위치/기기):\n  ${log.device_info || '-'}`
                    );
                };
            });
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger); padding:16px;">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    function renderAdminCloudSettings() {
        const kakaoKey = getKakaoAppKey();
        const kakaoInput = document.getElementById('kakao-key-input');
        if (kakaoInput) kakaoInput.value = kakaoKey;

        const kakaoStatus = document.getElementById('kakao-status-indicator');
        if (kakaoStatus) {
            if (state.engine === 'kakao') {
                kakaoStatus.innerHTML = `<span style="color:var(--success); font-weight:800;">🟢 현재 지도 엔진: 카카오맵(Kakao Maps) 정식 연동 중</span>`;
            } else if (kakaoKey && window.location.protocol === 'file:') {
                kakaoStatus.innerHTML = `<span style="color:var(--warning); font-weight:800;">🟡 카카오 키 입력됨 (로컬 file:// 환경에서는 카카오 보안 정책상 기본 지도가 뜨며, GitHub Pages 배포 주소에서 카카오맵으로 작동합니다)</span>`;
            } else {
                kakaoStatus.innerHTML = `<span style="color:var(--warning); font-weight:800;">🟡 현재 지도 엔진: 기본 지도 (아래에 Kakao JavaScript 키 입력 시 카카오맵으로 전환)</span>`;
            }
        }

        const { url, anonKey } = window.WCDB.getSupabaseCredentials();
        document.getElementById('supabase-url-input').value = url;
        document.getElementById('supabase-key-input').value = anonKey;

        const statusBox = document.getElementById('cloud-status-indicator');
        if (window.WCDB.isCloudMode()) {
            statusBox.innerHTML = `<span style="color:var(--success); font-weight:800;">🟢 현재 상태: Supabase 실시간 클라우드 DB 연동됨</span>`;
        } else {
            statusBox.innerHTML = `<span style="color:var(--warning); font-weight:800;">🟡 현재 상태: 로컬 스토리지 모드 (아래에 무료 Supabase URL/Key 입력 시 즉시 클라우드 전환)</span>`;
        }
    }

    function updateFilterChipsUI() {
        document.querySelectorAll('#filter-chips .chip').forEach(chip => {
            chip.classList.toggle('active', chip.getAttribute('data-filter') === state.activeFilter);
        });
    }

    // ========================================================================
    // 이벤트 리스너 초기화
    // ========================================================================
    // ========================================================================
    // PWA: 서비스 워커 등록 + 홈 화면에 추가(앱 설치) 안내
    // ========================================================================
    const INSTALL_DISMISS_KEY = 'wc_install_dismissed_at';
    let deferredInstallPrompt = null;

    function isStandaloneApp() {
        return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    }

    function wasInstallBannerDismissed() {
        try {
            const at = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0);
            return Date.now() - at < 7 * 24 * 60 * 60 * 1000; // 닫으면 7일간 다시 안 띄움
        } catch (e) {
            return false;
        }
    }

    function hideInstallBanner(remember) {
        const banner = document.getElementById('install-banner');
        if (banner) banner.classList.remove('show');
        if (remember) {
            try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch (e) { /* 무시 */ }
        }
    }

    function showInstallBanner(desc, showInstallBtn) {
        const banner = document.getElementById('install-banner');
        if (!banner || isStandaloneApp() || wasInstallBannerDismissed()) return;
        document.getElementById('install-banner-desc').innerHTML = desc;
        document.getElementById('btn-install-app').style.display = showInstallBtn ? '' : 'none';
        banner.classList.add('show');
    }

    if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(err => console.warn('서비스 워커 등록 실패:', err));
        });
    }

    // 안드로이드(크롬/삼성 인터넷/엣지): 브라우저가 설치 가능하다고 알려주면 설치 버튼 노출
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        showInstallBanner('홈 화면에 추가하면 앱처럼 바로 열 수 있어요.', true);
    });

    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        hideInstallBanner(true);
        showToast('📲 대똥여지도가 홈 화면에 추가되었습니다!');
    });

    function initInstallPrompt() {
        bindById('btn-install-app', 'click', async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            const choice = await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            hideInstallBanner(choice.outcome !== 'accepted');
        });
        bindById('btn-install-close', 'click', () => hideInstallBanner(true));

        // 아이폰/아이패드는 자동 설치 창이 없으므로 직접 추가하는 방법을 안내
        const ua = navigator.userAgent;
        const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (isIOS && !isStandaloneApp()) {
            const isInApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua);
            const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|Whale/i.test(ua) && !isInApp;
            const desc = isSafari
                ? '하단 <b>공유 버튼(⬆️)</b> → <b>"홈 화면에 추가"</b>를 눌러주세요.'
                : '<b>사파리(Safari)</b>로 연 뒤 <b>공유(⬆️)</b> → <b>"홈 화면에 추가"</b>를 눌러주세요.';
            setTimeout(() => showInstallBanner(desc, false), 1500);
        }
    }

    // 요소가 없어도(캐시된 구버전 HTML 등) 예외 없이 건너뛰어 나머지 초기화가 계속되도록 함
    function bindById(id, type, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(type, handler);
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) modal.classList.remove('open');
    }

    document.addEventListener('DOMContentLoaded', () => {
        // 모달 닫기(×/취소/배경 클릭/ESC)와 바텀시트는 다른 초기화 실패와 무관하게 가장 먼저 연결
        document.addEventListener('click', (e) => {
            const closeBtn = e.target.closest('[data-close-modal]');
            if (closeBtn) {
                e.preventDefault();
                closeModal(closeBtn.getAttribute('data-close-modal'));
                return;
            }
            if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
                e.target.classList.remove('open');
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
        });

        try {
            initBottomSheet();
        } catch (err) {
            console.error('바텀시트 초기화 실패:', err);
        }

        try {
            initInstallPrompt();
        } catch (err) {
            console.error('앱 설치 안내 초기화 실패:', err);
        }

        initTheme();
        checkInitialAuth();

        // 1. 로그인 폼 제출
        const loginForm = document.getElementById('login-form');
        const loginError = document.getElementById('login-error');
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            loginError.style.display = 'none';
            const username = document.getElementById('login-username').value;
            const password = document.getElementById('login-password').value;
            const rememberMe = document.getElementById('login-remember').checked;

            const submitBtn = document.getElementById('login-submit-btn');
            submitBtn.disabled = true;
            submitBtn.textContent = '인증 확인 중...';

            try {
                const user = await window.WCDB.login(username, password, rememberMe);
                document.getElementById('login-password').value = '';
                showToast(`환영합니다, ${user.display_name}님!`);
                await enterApp(user);
            } catch (err) {
                loginError.textContent = err.message;
                loginError.style.display = 'block';
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = '지도 접속하기';
            }
        });

        // 비밀번호 표시/숨기기 토글
        bindById('btn-toggle-pw', 'click', () => {
            const pwInput = document.getElementById('login-password');
            const isPw = pwInput.type === 'password';
            pwInput.type = isPw ? 'text' : 'password';
            document.getElementById('btn-toggle-pw').textContent = isPw ? '🙈' : '👁️';
        });

        // 2. 상단/사이드바 버튼들
        bindById('btn-theme-toggle', 'click', toggleTheme);

        bindById('btn-logout', 'click', async () => {
            if (!confirm('로그아웃 하시겠습니까?')) return;
            await window.WCDB.logout();
            showToast('로그아웃 되었습니다.');
            showLoginScreen();
        });

        // 내 비밀번호 변경 모달
        bindById('btn-change-my-pw', 'click', () => {
            document.getElementById('my-pw-form').reset();
            document.getElementById('my-pw-modal').classList.add('open');
        });

        bindById('my-pw-form', 'submit', async (e) => {
            e.preventDefault();
            const curPw = document.getElementById('my-cur-pw').value;
            const newPw = document.getElementById('my-new-pw').value;
            const newPw2 = document.getElementById('my-new-pw-confirm').value;

            if (newPw !== newPw2) {
                showToast('새 비밀번호 확인이 일치하지 않습니다.');
                return;
            }
            try {
                await window.WCDB.changeMyPassword(curPw, newPw);
                document.getElementById('my-pw-modal').classList.remove('open');
                showToast('✅ 비밀번호가 성공적으로 변경되었습니다.');
            } catch (err) {
                showToast(err.message);
            }
        });

        // 3. 검색창 & 필터 칩
        const searchInput = document.getElementById('search-input');
        const clearSearchBtn = document.getElementById('btn-clear-search');
        searchInput.addEventListener('input', () => {
            state.searchQuery = searchInput.value;
            clearSearchBtn.style.display = state.searchQuery ? 'block' : 'none';
            recalculateDistancesAndFilter();
        });
        clearSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            state.searchQuery = '';
            clearSearchBtn.style.display = 'none';
            recalculateDistancesAndFilter();
        });

        document.querySelectorAll('#filter-chips .chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const filter = chip.getAttribute('data-filter');
                if (filter === 'nearest' && !state.userLocation) {
                    findNearestRestroom();
                    return;
                }
                state.activeFilter = filter;
                updateFilterChipsUI();
                recalculateDistancesAndFilter();
            });
        });

        // 4. 급똥(가까운 변소 찾기) & 화장실 추가 플로팅 버튼 & 우측 상단 +- 줌 버튼
        bindById('fab-nearest', 'click', findNearestRestroom);
        bindById('fab-add-wc', 'click', () => openRestroomModal(null));
        bindById('btn-header-add-wc', 'click', () => openRestroomModal(null));

        const btnZoomIn = document.getElementById('btn-zoom-in');
        const btnZoomOut = document.getElementById('btn-zoom-out');
        if (btnZoomIn) btnZoomIn.addEventListener('click', () => zoomMapBy(1));
        if (btnZoomOut) btnZoomOut.addEventListener('click', () => zoomMapBy(-1));
        bindById('btn-my-location', 'click', goToMyLocation);

        // 5. 화장실 추가/수정 모달 내부 이벤트
        bindById('wc-separated', 'change', syncPasswordFieldsVisibility);
        bindById('btn-pick-on-map', 'click', startLocationPicking);
        bindById('btn-cancel-pick', 'click', () => {
            stopLocationPicking();
            document.getElementById('wc-modal').classList.add('open');
        });
        bindById('btn-confirm-pick', 'click', confirmLocationPicking);
        bindById('pick-search-form', 'submit', handlePickSearch);
        bindById('btn-pick-my-gps', 'click', () => {
            if (!navigator.geolocation) {
                showToast('브라우저에서 GPS를 지원하지 않습니다.');
                return;
            }
            showToast('📡 현재 내 위치로 이동하는 중...');
            navigator.geolocation.getCurrentPosition(
                pos => moveMapTo(pos.coords.longitude, pos.coords.latitude, 18),
                () => showToast('위치 권한을 허용해주세요.'),
                { enableHighAccuracy: true, timeout: 7000, maximumAge: 30000 }
            );
        });
        bindById('btn-use-my-gps', 'click', () => {
            if (!navigator.geolocation) {
                showToast('브라우저에서 GPS를 지원하지 않습니다.');
                return;
            }
            showToast('📡 현재 내 위치와 동네명을 확인하는 중...');
            navigator.geolocation.getCurrentPosition(
                async pos => {
                    const lat = Number(pos.coords.latitude.toFixed(7));
                    const lng = Number(pos.coords.longitude.toFixed(7));
                    document.getElementById('wc-lat').value = lat;
                    document.getElementById('wc-lng').value = lng;
                    const regionText = await autoFillRegionFromCoords(lat, lng);
                    showToast(regionText ? `📍 내 현재 위치 [${regionText}] 입력 완료!` : '📍 현재 내 GPS 좌표가 입력되었습니다.');
                },
                () => showToast('위치 권한을 허용해주세요.')
            );
        });
        bindById('wc-form', 'submit', handleSaveRestroomForm);

        // 6. 관리자 센터 이벤트
        bindById('btn-open-admin', 'click', () => openAdminModal('users'));
        document.querySelectorAll('.admin-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => switchAdminTab(btn.getAttribute('data-admin-tab')));
        });

        const adminWcSearch = document.getElementById('admin-wc-search');
        if (adminWcSearch) {
            adminWcSearch.addEventListener('input', () => renderAdminRestroomsTable());
        }

        const adminLogFilter = document.getElementById('admin-log-filter');
        if (adminLogFilter) {
            adminLogFilter.addEventListener('change', () => renderAdminLogsTable());
        }

        const btnRefreshLogs = document.getElementById('btn-refresh-logs');
        if (btnRefreshLogs) {
            btnRefreshLogs.addEventListener('click', () => renderAdminLogsTable());
        }

        // 관리자: 신규 사용자 계정 부여 폼
        bindById('admin-create-user-form', 'submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('new-user-id').value.trim();
            const password = document.getElementById('new-user-pw').value;
            const display_name = document.getElementById('new-user-name').value.trim();
            const role = document.getElementById('new-user-role').value;
            const memo = document.getElementById('new-user-memo').value.trim();

            try {
                await window.WCDB.adminSaveUser({ username, password, display_name, role, memo, is_active: true });
                state.lastCreatedCredentials[username] = password;
                e.target.reset();
                showToast(`🎉 [${username}] 계정이 생성되었습니다! 우측 '계정안내 복사'를 눌러 전달하세요.`);
                await renderAdminUsersList();
            } catch (err) {
                showToast('계정 생성 실패: ' + err.message);
            }
        });

        // 관리자: JSON 백업 내보내기
        bindById('btn-export-json', 'click', () => {
            const blob = new Blob([JSON.stringify(state.restrooms, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `wc-restrooms-backup-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('📦 화장실 데이터 JSON 백업 파일이 다운로드되었습니다.');
        });

        // 관리자: 카카오맵 API 키 저장
        const btnSaveKakao = document.getElementById('btn-save-kakao');
        if (btnSaveKakao) {
            btnSaveKakao.addEventListener('click', async () => {
                const key = (document.getElementById('kakao-key-input').value || '').trim();
                if (!key) {
                    localStorage.removeItem('wc_kakao_app_key');
                    showToast('카카오맵 키가 제거되어 기본 지도로 전환합니다.');
                } else {
                    localStorage.setItem('wc_kakao_app_key', key);
                    showToast('🟡 카카오맵 API 키가 저장되었습니다! 지도를 다시 불러옵니다...');
                }
                state.kakaoMap = null;
                state.map = null;
                await initMap();
                renderMapMarkers();
                renderAdminCloudSettings();
            });
        }

        // 관리자: Supabase 연동 저장
        bindById('btn-save-supabase', 'click', async () => {
            const url = document.getElementById('supabase-url-input').value.trim();
            const key = document.getElementById('supabase-key-input').value.trim();
            if (!url || !key) {
                showToast('Supabase Project URL과 Anon Key를 모두 입력해주세요.');
                return;
            }
            const ok = window.WCDB.saveSupabaseCredentials(url, key);
            if (ok) {
                showToast('✅ Supabase 클라우드 설정이 저장되었습니다. 다시 로그인해주세요.');
                await window.WCDB.logout();
                document.getElementById('admin-modal').classList.remove('open');
                showLoginScreen();
            } else {
                showToast('설정 초기화에 실패했습니다. URL과 Key를 확인해주세요.');
            }
        });

        bindById('btn-disconnect-supabase', 'click', async () => {
            if (!confirm('클라우드 연동을 해제하고 로컬 모드로 전환하시겠습니까?')) return;
            window.WCDB.saveSupabaseCredentials('', '');
            await window.WCDB.logout();
            document.getElementById('admin-modal').classList.remove('open');
            showToast('로컬 모드로 전환되었습니다.');
            showLoginScreen();
        });

    });

    // ========================================================================
    // 모바일 바텀시트: 3단 스냅(접힘/중간/펼침) + 스와이프 드래그
    // ========================================================================
    const SHEET_STATES = ['collapsed', 'half', 'expanded'];

    function isMobileLayout() {
        return window.matchMedia('(max-width: 820px)').matches;
    }

    function getSheetSnapHeights() {
        const vh = window.innerHeight;
        return { collapsed: 142, half: Math.round(vh * 0.46), expanded: Math.round(vh * 0.88) };
    }

    function setSheetState(next) {
        const panel = document.getElementById('side-panel');
        const shell = document.getElementById('app-shell');
        if (!panel || !shell) return;
        state.sheetState = next;
        panel.style.height = '';
        panel.classList.toggle('collapsed', next === 'collapsed');
        panel.classList.toggle('expanded', next === 'expanded');
        shell.classList.toggle('sheet-expanded', next === 'expanded');
        shell.style.setProperty('--sheet-h', `${getSheetSnapHeights()[next]}px`);
    }

    function initBottomSheet() {
        const panel = document.getElementById('side-panel');
        const shell = document.getElementById('app-shell');
        const handle = document.getElementById('mobile-sheet-handle');
        const header = panel && panel.querySelector('.panel-header');
        const list = document.getElementById('restroom-list');
        if (!panel || !shell || !handle) return;

        setSheetState(state.sheetState);
        window.addEventListener('resize', () => setSheetState(state.sheetState));

        // 핸들 탭: 열려 있으면 내려서 지도를 크게, 접혀 있으면 중간 높이로 올림
        handle.addEventListener('click', () => {
            if (drag.moved) return;
            setSheetState(state.sheetState === 'collapsed' ? 'half' : 'collapsed');
        });

        // 검색창을 누르면 결과 목록이 보이도록 시트를 펼침
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('focus', () => {
                if (isMobileLayout() && state.sheetState === 'collapsed') setSheetState('half');
            });
        }

        const drag = { active: false, decided: false, moved: false, startY: 0, startX: 0, startH: 0, lastY: 0, lastT: 0, velocity: 0, fromList: false };

        function onStart(clientX, clientY, fromList) {
            if (!isMobileLayout()) return;
            drag.active = true;
            drag.decided = false;
            drag.moved = false;
            drag.fromList = fromList;
            drag.startX = clientX;
            drag.startY = clientY;
            drag.lastY = clientY;
            drag.lastT = performance.now();
            drag.velocity = 0;
            drag.startH = panel.getBoundingClientRect().height;
        }

        // 반환값 true = 시트가 제스처를 가져감 (기본 스크롤 막기)
        function onMove(clientX, clientY) {
            if (!drag.active) return false;
            const dy = clientY - drag.startY;
            const dx = clientX - drag.startX;

            if (!drag.decided) {
                if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return false;
                // 가로 스와이프(필터 칩 스크롤 등)는 시트가 가로채지 않음
                if (Math.abs(dx) > Math.abs(dy)) {
                    drag.active = false;
                    return false;
                }
                // 목록 위에서는: 펼침 상태면 맨 위에서 아래로 당길 때만 시트를 내림
                if (drag.fromList && state.sheetState === 'expanded' && (dy < 0 || list.scrollTop > 0)) {
                    drag.active = false;
                    return false;
                }
                drag.decided = true;
                drag.moved = true;
                panel.classList.add('dragging');
                shell.classList.add('sheet-dragging');
                if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            }

            const snaps = getSheetSnapHeights();
            const h = Math.max(snaps.collapsed - 30, Math.min(snaps.expanded + 20, drag.startH - dy));
            panel.style.height = `${h}px`;
            shell.style.setProperty('--sheet-h', `${h}px`);

            const now = performance.now();
            const dt = Math.max(1, now - drag.lastT);
            drag.velocity = (clientY - drag.lastY) / dt; // +: 아래로, -: 위로 (px/ms)
            drag.lastY = clientY;
            drag.lastT = now;
            return true;
        }

        function onEnd() {
            if (!drag.active) return;
            drag.active = false;
            if (!drag.decided) return;

            panel.classList.remove('dragging');
            shell.classList.remove('sheet-dragging');

            const snaps = getSheetSnapHeights();
            const curH = panel.getBoundingClientRect().height;
            let target;
            if (Math.abs(drag.velocity) > 0.45) {
                // 빠르게 튕기면 진행 방향의 다음 단계로
                const ordered = SHEET_STATES.filter(s => (drag.velocity < 0 ? snaps[s] > curH : snaps[s] < curH));
                target = drag.velocity < 0 ? ordered[0] : ordered[ordered.length - 1];
            }
            if (!target) {
                target = SHEET_STATES.reduce((best, s) => (Math.abs(snaps[s] - curH) < Math.abs(snaps[best] - curH) ? s : best), 'half');
            }
            setSheetState(target);
            // 드래그 직후 발생하는 click(핸들 토글/카드 선택) 무시
            setTimeout(() => { drag.moved = false; }, 50);
        }

        function bindTouch(el, fromList) {
            if (!el) return;
            el.addEventListener('touchstart', (e) => {
                if (e.touches.length !== 1) return;
                if (!fromList && e.target.closest('input, select, textarea')) return;
                onStart(e.touches[0].clientX, e.touches[0].clientY, fromList);
            }, { passive: true });
            el.addEventListener('touchmove', (e) => {
                if (onMove(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) {
                    e.preventDefault();
                }
            }, { passive: false });
            el.addEventListener('touchend', onEnd);
            el.addEventListener('touchcancel', onEnd);
        }

        bindTouch(handle, false);
        bindTouch(header, false);
        bindTouch(document.querySelector('.restroom-list-header'), false);
        bindTouch(list, true);

        // 데스크톱 브라우저 모바일 뷰 테스트용 마우스 드래그 (핸들)
        handle.addEventListener('mousedown', (e) => {
            onStart(e.clientX, e.clientY, false);
            const mm = (ev) => onMove(ev.clientX, ev.clientY);
            const mu = () => {
                onEnd();
                window.removeEventListener('mousemove', mm);
                window.removeEventListener('mouseup', mu);
            };
            window.addEventListener('mousemove', mm);
            window.addEventListener('mouseup', mu);
        });

        // 드래그로 끝난 제스처가 카드 클릭으로 이어지지 않도록 캡처 단계에서 차단
        panel.addEventListener('click', (e) => {
            if (drag.moved) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
    }
})();
