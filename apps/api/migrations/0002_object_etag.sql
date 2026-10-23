-- 검증한 R2 객체 버전 고정(decisions/0011): ready 객체는 업로드별 고유 key + 검증 시점 etag 로 식별한다.
-- 다운로드·snapshot 파싱은 onlyIf.etagMatches 로 같은 객체 버전만 읽는다.
ALTER TABLE objects ADD COLUMN etag TEXT;
