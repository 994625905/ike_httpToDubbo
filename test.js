let cache = {
    name:'www',
    value:'ahaha'
}

for (let key in cache) {
    delete cache[key]
}
console.dir(cache)

let head = Buffer.from([0xda, 0xbb, 11000010, 0, 1, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
head.writeInt32BE(8848, 12);
console.dir(head)

const STATIC_BASE_DATA = '0123456789';    // 生产requestId使用
