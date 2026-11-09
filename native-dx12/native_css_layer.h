#pragma once
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace native_three {
struct UiElement {
    std::string tag, id, classNames, text;
    std::map<std::string,std::string> style;
};
inline std::string uiTrim(const std::string& s) {
    auto a=s.find_first_not_of(" \t\r\n");
    if(a==std::string::npos)return "";
    auto b=s.find_last_not_of(" \t\r\n");
    return s.substr(a,b-a+1);
}
inline std::string uiAttribute(const std::string& opening,const std::string& key) {
    auto p=opening.find(key+"=");
    if(p==std::string::npos)return "";
    p+=key.size()+1;
    if(p>=opening.size())return "";
    char quote=opening[p];
    if(quote!='\'' && quote!='"')return "";
    auto end=opening.find(quote,p+1);
    return end==std::string::npos?"":opening.substr(p+1,end-p-1);
}
inline std::vector<UiElement> parseUiElements(const std::string& html) {
    std::vector<UiElement> out;
    for(std::size_t p=0;(p=html.find('<',p))!=std::string::npos;) {
        auto end=html.find('>',p+1);
        if(end==std::string::npos)break;
        auto tagEnd=html.find_first_of(" \t\r\n/>",p+1);
        if(tagEnd==std::string::npos)break;
        std::string tag=html.substr(p+1,tagEnd-p-1);
        p=end+1;
        if(tag!="button" && tag!="div" && tag!="span" && tag!="img")continue;
        auto opening=html.substr(tagEnd,end-tagEnd);
        UiElement item;
        item.tag=tag; item.id=uiAttribute(opening,"id");
        item.classNames=uiAttribute(opening,"class");
        if(tag=="img")item.style["src"]=uiAttribute(opening,"src");
        else {
            auto close=html.find("</"+tag+">",p);
            if(close!=std::string::npos) {
                item.text=uiTrim(html.substr(p,close-p));
                if(item.text.find('<')!=std::string::npos)item.text="";
            }
        }
        out.push_back(std::move(item));
    }
    return out;
}
inline bool uiHasClass(const std::string& names,const std::string& wanted) {
    std::size_t p=0;
    while(p<names.size()) {
        auto e=names.find_first_of(" \t\r\n",p);
        if(names.substr(p,e==std::string::npos?e:e-p)==wanted)return true;
        if(e==std::string::npos)break;
        p=e+1;
    }
    return false;
}
inline void applyUiCss(std::vector<UiElement>& elements,const std::string& css) {
    std::string clean;
    for(std::size_t i=0;i<css.size();) {
        if(i+1<css.size() && css[i]=='/' && css[i+1]=='*') {
            auto e=css.find("*/",i+2); i=e==std::string::npos?css.size():e+2;
        } else clean+=css[i++];
    }
    struct Rule { std::string selector; std::map<std::string,std::string> values; int weight; };
    std::vector<Rule> rules;
    for(std::size_t p=0;p<clean.size();) {
        auto a=clean.find('{',p); if(a==std::string::npos)break;
        auto b=clean.find('}',a+1); if(b==std::string::npos)break;
        auto sel=uiTrim(clean.substr(p,a-p));
        Rule r{sel,{},sel.empty()?0:sel[0]=='#'?100:sel[0]=='.'?10:1};
        auto block=clean.substr(a+1,b-a-1);
        for(std::size_t q=0;q<block.size();) {
            auto semi=block.find(';',q);
            auto part=block.substr(q,semi==std::string::npos?semi:semi-q);
            auto colon=part.find(':');
            if(colon!=std::string::npos)r.values[uiTrim(part.substr(0,colon))]=uiTrim(part.substr(colon+1));
            if(semi==std::string::npos)break;
            q=semi+1;
        }
        rules.push_back(std::move(r)); p=b+1;
    }
    for(auto& element:elements) {
        std::map<std::string,int> priority;
        for(const auto& r:rules) {
            bool match=r.selector==element.tag ||
                (r.selector.size()>1 && r.selector[0]=='#' && r.selector.substr(1)==element.id) ||
                (r.selector.size()>1 && r.selector[0]=='.' && uiHasClass(element.classNames,r.selector.substr(1)));
            if(!match)continue;
            for(const auto& kv:r.values)if(priority[kv.first]<=r.weight) {
                priority[kv.first]=r.weight; element.style[kv.first]=kv.second;
            }
        }
    }
}
inline int uiPixels(const UiElement& e,const std::string& key,int fallback) {
    auto it=e.style.find(key);
    if(it==e.style.end())return fallback;
    auto s=uiTrim(it->second);
    char* end=nullptr;long v=std::strtol(s.c_str(),&end,10);
    if(end==s.c_str() || v<0 || v>10000)return fallback;
    return (*end==0 || std::string(end)=="px")?(int)v:fallback;
}
}
