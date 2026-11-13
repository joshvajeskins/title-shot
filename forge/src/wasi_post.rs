//! POST over wasi:http with the request body written in chunks of at most 4096 bytes.
//!
//! `wasi-http-client` 0.2.1 hands the whole body to one `blocking_write_and_flush`, which traps for
//! bodies over 4096 bytes (the real forge request is about 11 KB). Writing in 4096-byte chunks is not
//! enough: the request must also be started (`handle`) BEFORE the body is written, or the write blocks
//! forever on the small body pipe. Verified under wasmtime against the real API (401 with a dummy key).
//! GET still uses `wasi-http-client` (its response path is fine).
use std::time::Duration;
use titleshot_forge::compile::Resp;
use titleshot_forge::input::Failure;
use wasi::http::outgoing_handler;
use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
use wasi::io::streams::StreamError;

const CHUNK: usize = 4096;

fn fail(code: &'static str, what: &str) -> Failure {
    Failure::new(code, what)
}

pub fn post(authority: &str, path: &str, headers: &[(&str, String)], body: &[u8], connect: Duration) -> Result<Resp, Failure> {
    let list: Vec<(String, Vec<u8>)> = headers.iter().map(|(k, v)| (k.to_string(), v.clone().into_bytes())).collect();
    let fields = Fields::from_list(&list).map_err(|_| fail("E_HTTP", "bad headers"))?;
    let req = OutgoingRequest::new(fields);
    req.set_method(&Method::Post).map_err(|()| fail("E_HTTP", "method"))?;
    req.set_scheme(Some(&Scheme::Https)).map_err(|()| fail("E_HTTP", "scheme"))?;
    req.set_authority(Some(authority)).map_err(|()| fail("E_HTTP", "authority"))?;
    req.set_path_with_query(Some(path)).map_err(|()| fail("E_HTTP", "path"))?;

    let out = req.body().map_err(|_| fail("E_HTTP", "body handle"))?;
    let options = RequestOptions::new();
    options.set_connect_timeout(Some(connect.as_nanos() as u64)).map_err(|()| fail("E_HTTP", "timeout"))?;
    // Start the request BEFORE writing the body: the body pipe has a small buffer and the host only
    // drains it once the request is in flight, so writing first deadlocks on bodies over a few KB.
    let future = outgoing_handler::handle(req, Some(options)).map_err(|e| fail("E_HTTP", &format!("handle: {e:?}")))?;
    {
        let stream = out.write().map_err(|_| fail("E_HTTP", "body stream"))?;
        for chunk in body.chunks(CHUNK) {
            stream.blocking_write_and_flush(chunk).map_err(|e| fail("E_HTTP", &format!("write: {e:?}")))?;
        }
        // the stream child must drop before the body is finished
    }
    OutgoingBody::finish(out, None).map_err(|e| fail("E_HTTP", &format!("finish: {e:?}")))?;
    let incoming = loop {
        if let Some(r) = future.get() {
            break r.map_err(|()| fail("E_HTTP", "response taken"))?.map_err(|e| fail("E_HTTP", &format!("response: {e:?}")))?;
        }
        future.subscribe().block();
    };
    drop(future);

    let status = incoming.status();
    let body_in = incoming.consume().map_err(|()| fail("E_HTTP_BODY", "consume"))?;
    drop(incoming);
    let input = body_in.stream().map_err(|()| fail("E_HTTP_BODY", "stream"))?;
    let mut bytes = Vec::new();
    loop {
        match input.blocking_read(1 << 20) {
            Ok(mut c) => bytes.append(&mut c),
            Err(StreamError::Closed) => break,
            Err(e) => return Err(fail("E_HTTP_BODY", &format!("read: {e:?}"))),
        }
    }
    drop(input);
    drop(body_in);
    Ok(Resp { status, body: bytes })
}
