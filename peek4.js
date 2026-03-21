const d=require("fs").readFileSync("qwen-out-utf8.json","utf8");const i=d.lastIndexOf("{\"type\":\"result\"");console.log(d.slice(i,i+400))
