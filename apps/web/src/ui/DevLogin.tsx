import { useState } from 'react';
import { useCloud } from '../sync/cloud.ts';

/** 개발 전용(fake auth) 로그인 폼. production 빌드에는 포함되지 않는다. */
export default function DevLogin() {
  const [user, setUser] = useState('alice');
  return (
    <div className="row">
      <label className="row">개발용 사용자 <input aria-label="개발용 사용자" value={user} onChange={(e) => setUser(e.target.value)} /></label>
      <button onClick={() => useCloud.getState().login(user)}>개발용 로그인(fake)</button>
      <span className="warn">localhost 개발 서버 전용 가짜 인증입니다. 실제 로그인 공급자는 D07 선택 후 연결합니다.</span>
    </div>
  );
}
