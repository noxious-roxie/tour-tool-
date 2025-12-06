export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing url', { status: 400 });
    const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin':'*' }});
  }
}
