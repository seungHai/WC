-- ============================================================================
-- 대똥여지도 (WC Map) - 화장실 평가(별점 · 빠른 상태 태그 · 한줄평) 테이블 및 RPC 쿼리
-- 사용법: Supabase 대시보드 -> SQL Editor -> New Query 에 붙여넣고 Run 클릭
-- ============================================================================

-- 1. 화장실 평가(리뷰) 테이블 생성
-- 프라이빗 화장실(UUID 문자열)과 공중화장실('pub-...' 식별자) 모두 호환되도록 restroom_id는 TEXT로 저장
CREATE TABLE IF NOT EXISTS public.restroom_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restroom_id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    tags TEXT[] NOT NULL DEFAULT '{}',
    comment TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (restroom_id, username)
);

CREATE INDEX IF NOT EXISTS idx_restroom_reviews_restroom_id ON public.restroom_reviews (restroom_id);
CREATE INDEX IF NOT EXISTS idx_restroom_reviews_created_at ON public.restroom_reviews (created_at DESC);

-- 2. Row Level Security (RLS) 활성화
ALTER TABLE public.restroom_reviews ENABLE ROW LEVEL SECURITY;

-- 3. [평가 RPC 1] 전체 화장실별 평균 별점 및 평가 개수 집계 조회 (지도/리스트 배지 및 별점순 정렬용)
CREATE OR REPLACE FUNCTION public.rpc_get_review_summaries(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_result JSONB;
BEGIN
    PERFORM public.internal_validate_token(p_token);

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'restroom_id', s.restroom_id,
            'avg_rating', ROUND(s.avg_rating::numeric, 1),
            'review_count', s.review_count
        )
    ), '[]'::jsonb)
    INTO v_result
    FROM (
        SELECT
            restroom_id,
            AVG(rating) AS avg_rating,
            COUNT(*) AS review_count
        FROM public.restroom_reviews
        GROUP BY restroom_id
    ) s;

    RETURN v_result;
END;
$$;

-- 4. [평가 RPC 2] 특정 화장실의 상세 평가 목록 조회
CREATE OR REPLACE FUNCTION public.rpc_get_restroom_reviews(
    p_token TEXT,
    p_restroom_id TEXT
)
RETURNS SETOF public.restroom_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    PERFORM public.internal_validate_token(p_token);

    RETURN QUERY
    SELECT *
    FROM public.restroom_reviews
    WHERE restroom_id = trim(p_restroom_id)
    ORDER BY updated_at DESC;
END;
$$;

-- 5. [평가 RPC 3] 화장실 평가 등록 / 수정 (회원당 화장실별 1개 Upsert + 감사 로그 기록)
CREATE OR REPLACE FUNCTION public.rpc_upsert_restroom_review(
    p_token TEXT,
    p_restroom_id TEXT,
    p_restroom_name TEXT DEFAULT '',
    p_rating INT DEFAULT 5,
    p_tags TEXT[] DEFAULT '{}',
    p_comment TEXT DEFAULT ''
)
RETURNS public.restroom_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
    v_review public.restroom_reviews;
    v_clean_rating INT;
BEGIN
    v_user := public.internal_validate_token(p_token);

    IF trim(COALESCE(p_restroom_id, '')) = '' THEN
        RAISE EXCEPTION '평가할 화장실 정보가 올바르지 않습니다.';
    END IF;

    v_clean_rating := GREATEST(1, LEAST(5, COALESCE(p_rating, 5)));

    INSERT INTO public.restroom_reviews (
        restroom_id, username, display_name, rating, tags, comment, updated_at
    ) VALUES (
        trim(p_restroom_id),
        v_user.username,
        v_user.display_name,
        v_clean_rating,
        COALESCE(p_tags, '{}'),
        trim(COALESCE(p_comment, '')),
        now()
    )
    ON CONFLICT (restroom_id, username) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        rating = EXCLUDED.rating,
        tags = EXCLUDED.tags,
        comment = EXCLUDED.comment,
        updated_at = now()
    RETURNING * INTO v_review;

    PERFORM public.internal_write_log(
        'REVIEW_UPSERT',
        v_user.username,
        v_user.display_name,
        COALESCE(NULLIF(trim(p_restroom_name), ''), trim(p_restroom_id)),
        format('별점 %s점 평가 등록 (%s)', v_clean_rating, left(trim(COALESCE(p_comment, '')), 40)),
        ''
    );

    RETURN v_review;
END;
$$;

-- 6. [평가 RPC 4] 화장실 평가 삭제 (본인 또는 관리자)
CREATE OR REPLACE FUNCTION public.rpc_delete_restroom_review(
    p_token TEXT,
    p_review_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_user public.app_users;
    v_target public.restroom_reviews;
BEGIN
    v_user := public.internal_validate_token(p_token);

    SELECT * INTO v_target FROM public.restroom_reviews WHERE id = p_review_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF v_user.role <> 'admin' AND v_target.username <> v_user.username THEN
        RAISE EXCEPTION '본인이 작성한 평가만 삭제할 수 있습니다.';
    END IF;

    DELETE FROM public.restroom_reviews WHERE id = p_review_id;

    PERFORM public.internal_write_log(
        'REVIEW_DELETE',
        v_user.username,
        v_user.display_name,
        v_target.restroom_id,
        '화장실 평가 삭제',
        ''
    );

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_review_summaries(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_restroom_reviews(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_restroom_review(TEXT, TEXT, TEXT, INT, TEXT[], TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_restroom_review(TEXT, UUID) TO anon, authenticated;
