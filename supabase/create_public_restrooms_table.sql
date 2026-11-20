-- ============================================================================
-- 대똥여지도 (WC Map) - 전국 공중화장실 정보 전용 테이블 스키마 & RPC 생성 쿼리
-- 사용법: Supabase 대시보드 -> SQL Editor -> New Query 에 붙여넣고 Run 클릭
-- ============================================================================

-- 1. 공중화장실 정보 전용 테이블 (public.public_restrooms) 생성
CREATE TABLE IF NOT EXISTS public.public_restrooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gov_code TEXT NOT NULL DEFAULT '',                  -- 개방자치단체코드
    manage_no TEXT UNIQUE NOT NULL,                     -- 관리번호 (고유 식별자)
    category TEXT NOT NULL DEFAULT '공중화장실',        -- 구분명 (공중화장실, 개방화장실 등)
    legal_basis TEXT DEFAULT '',                        -- 근거법령명
    name TEXT NOT NULL,                                 -- 화장실명
    road_address TEXT DEFAULT '',                       -- 소재지도로명주소
    jibun_address TEXT DEFAULT '',                      -- 소재지지번주소
    lat DOUBLE PRECISION NOT NULL,                      -- 위도 (WGS84)
    lng DOUBLE PRECISION NOT NULL,                      -- 경도 (WGS84)
    region TEXT DEFAULT '',                             -- 지역 분류 (시/도 시/군/구)
    male_toilet_count INT NOT NULL DEFAULT 0,           -- 남성용-대변기수
    male_urinal_count INT NOT NULL DEFAULT 0,           -- 남성용-소변기수
    male_disabled_toilet_count INT NOT NULL DEFAULT 0,  -- 남성용-장애인용대변기수
    male_disabled_urinal_count INT NOT NULL DEFAULT 0,  -- 남성용-장애인용소변기수
    male_child_toilet_count INT NOT NULL DEFAULT 0,     -- 남성용-어린이용대변기수
    male_child_urinal_count INT NOT NULL DEFAULT 0,     -- 남성용-어린이용소변기수
    female_toilet_count INT NOT NULL DEFAULT 0,         -- 여성용-대변기수
    female_disabled_toilet_count INT NOT NULL DEFAULT 0,-- 여성용-장애인용대변기수
    female_child_toilet_count INT NOT NULL DEFAULT 0,   -- 여성용-어린이용대변기수
    managing_agency TEXT DEFAULT '',                    -- 관리기관명
    phone_number TEXT DEFAULT '',                       -- 전화번호
    open_hours TEXT DEFAULT '',                         -- 개방시간
    open_hours_detail TEXT DEFAULT '',                  -- 개방시간상세
    installed_ym TEXT DEFAULT '',                       -- 설치연월
    ownership_type TEXT DEFAULT '',                     -- 화장실소유구분명
    waste_treatment_type TEXT DEFAULT '',               -- 오물처리방식
    safety_target_yn BOOLEAN NOT NULL DEFAULT false,    -- 안전관리시설설치대상여부
    emergency_bell_yn BOOLEAN NOT NULL DEFAULT false,   -- 비상벨설치여부
    emergency_bell_location TEXT DEFAULT '',            -- 비상벨설치장소
    cctv_yn BOOLEAN NOT NULL DEFAULT false,             -- 화장실입구CCTV설치유무
    diaper_table_yn BOOLEAN NOT NULL DEFAULT false,     -- 기저귀교환대유무
    diaper_table_location TEXT DEFAULT '',              -- 기저귀교환대장소
    remodeled_ym TEXT DEFAULT '',                       -- 리모델링연월
    reference_date TEXT DEFAULT '',                     -- 데이터기준일자
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 빠른 지역/좌표 검색을 위한 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_public_restrooms_region ON public.public_restrooms (region);
CREATE INDEX IF NOT EXISTS idx_public_restrooms_coords ON public.public_restrooms (lat, lng);
CREATE INDEX IF NOT EXISTS idx_public_restrooms_name ON public.public_restrooms (name);

-- 2. Row Level Security (RLS) 활성화 (schema.sql 보안 아키텍처 준수)
ALTER TABLE public.public_restrooms ENABLE ROW LEVEL SECURITY;

-- 3. [공중화장실 RPC] 지역/키워드/지도 영역(Bounding Box) 기반 공중화장실 목록 조회 함수
CREATE OR REPLACE FUNCTION public.rpc_get_public_restrooms(
    p_token TEXT,
    p_region TEXT DEFAULT '',
    p_keyword TEXT DEFAULT '',
    p_limit INT DEFAULT 250,
    p_min_lat DOUBLE PRECISION DEFAULT NULL,
    p_max_lat DOUBLE PRECISION DEFAULT NULL,
    p_min_lng DOUBLE PRECISION DEFAULT NULL,
    p_max_lng DOUBLE PRECISION DEFAULT NULL
)
RETURNS SETOF public.public_restrooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    PERFORM public.internal_validate_token(p_token);

    RETURN QUERY
    SELECT *
    FROM public.public_restrooms
    WHERE (p_region = '' OR region ILIKE '%' || trim(p_region) || '%' OR road_address ILIKE '%' || trim(p_region) || '%' OR jibun_address ILIKE '%' || trim(p_region) || '%')
      AND (p_keyword = '' OR name ILIKE '%' || trim(p_keyword) || '%' OR road_address ILIKE '%' || trim(p_keyword) || '%' OR jibun_address ILIKE '%' || trim(p_keyword) || '%')
      AND (p_min_lat IS NULL OR lat >= p_min_lat)
      AND (p_max_lat IS NULL OR lat <= p_max_lat)
      AND (p_min_lng IS NULL OR lng >= p_min_lng)
      AND (p_max_lng IS NULL OR lng <= p_max_lng)
    ORDER BY name ASC
    LIMIT LEAST(COALESCE(p_limit, 250), 2000);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_public_restrooms(TEXT, TEXT, TEXT, INT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION) TO anon, authenticated;
