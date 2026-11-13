//! Pure logic of the forge app: input validation, request body, output encoding. Host-testable.
pub mod compile;
pub mod input;
pub mod output;
pub mod request;

#[cfg(test)]
mod compile_tests;
#[cfg(test)]
mod tests;
