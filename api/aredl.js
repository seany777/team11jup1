export default async function handler(req, res) {
    const response = await fetch(
        "https://api.aredl.net/api/aredl/levels?page=1&pageSize=100",
        {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://aredl.net"
            }
        }
    );
    const data = await response.json();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(data);
}
