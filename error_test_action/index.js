console.log("error[E0080]: evaluation of constant value failed")
console.log(" --> library/alloc/src/collections/btree/node.rs:1679:38")
console.log("|")
console.log("1679 | const TRAVERSAL_PERMIT: () = panic!();")
console.log("| ^^^^^^^^ the evaluated program panicked at 'explicit panic', library/alloc/src/collections/btree/node.rs:1679:38")
console.log("|")
console.log(" = note: this error originates in the macro `$crate::panic::panic_2021` which comes from the expansion of the macro `panic` (in Nightly builds, run with -Z macro-backtrace for more info)")
console.log()
console.log("For more information about this error, try `rustc --explain E0080`.")


console.log(`
error[E0080]: evaluation of constant value failed
--> library/alloc/src/collections/btree/node.rs:1679:38
|
1679 | const TRAVERSAL_PERMIT: () = panic!();
| ^^^^^^^^ the evaluated program panicked at 'explicit panic', library/alloc/src/collections/btree/node.rs:1679:38
|
= note: this error originates in the macro "$crate::panic::panic_2021" which comes from the expansion of the macro "panic" (in Nightly builds, run with -Z macro-backtrace for more info)

For more information about this error, try "rustc --explain E0080".
`)


console.error(`
error[E0080]: evaluation of constant value failed
--> library/alloc/src/collections/btree/node.rs:1679:38
|
1679 | const TRAVERSAL_PERMIT: () = panic!();
| ^^^^^^^^ the evaluated program panicked at 'explicit panic', library/alloc/src/collections/btree/node.rs:1679:38
|
= note: this error originates in the macro "$crate::panic::panic_2021" which comes from the expansion of the macro "panic" (in Nightly builds, run with -Z macro-backtrace for more info)

For more information about this error, try "rustc --explain E0080".
`)
